/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from './entities/user.schema';
import { Bus, BusDocument } from '../transit/entities/bus.schema';
import { BusTrip, BusTripDocument } from '../transit/entities/bus-trip.schema';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { CreateUserDto } from './dto/create-user.dto';
import { LoginDto } from './dto/login.dto';
import { JwtService } from '@nestjs/jwt';
import { REDIS_CLIENT } from '../../shared/redis/redis.module';
import Redis from 'ioredis';
import { MailerService } from '@nestjs-modules/mailer';
import { UserRole, UserStatus } from './enums/role.enum';
import { Types } from 'mongoose';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth, DecodedIdToken } from 'firebase-admin/auth';

@Injectable()
export class UsersService implements OnModuleInit {
  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    @InjectModel(Bus.name) private busModel: Model<BusDocument>,
    // Only used to refuse deleting a driver who is mid-trip. Registered via
    // MongooseModule.forFeature in UsersModule, so this pulls in the schema
    // without importing TransitModule — which imports UsersModule and would
    // make the dependency circular.
    @InjectModel(BusTrip.name)
    private busTripModel: Model<BusTripDocument>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly mailerService: MailerService,
    private jwtService: JwtService,
  ) {}

  /**
   * Drop the pre-#31 `firebaseUid_1` index, which was created while the field
   * still defaulted to null and so is NOT sparse. Mongoose leaves an existing
   * index alone when the schema's spec changes, so without this every account
   * created without a Firebase UID would collide on `firebaseUid: null` with
   * an E11000 duplicate-key error. The sparse index is then rebuilt from the
   * schema. Safe to keep permanently — a no-op once the index is gone.
   */
  async onModuleInit() {
    try {
      await this.userModel.collection.dropIndex('firebaseUid_1');
      console.log('Successfully dropped old firebaseUid index');
    } catch {
      // Index already dropped or never existed — nothing to do.
    }
  }

  async create(userData: CreateUserDto) {
    const cleanEmail = userData.email.trim().toLowerCase();
    const salt = await bcrypt.genSalt();
    const hashedPassword = await bcrypt.hash(userData.password, salt);

    let user = await this.userModel.findOne({ email: cleanEmail }).exec();
    if (user) {
      if (user.isVerified) {
        throw new ConflictException(
          'អ៊ីមែលនេះត្រូវបានប្រើប្រាស់រួចហើយ (Email already registered)',
        );
      }
      // Update details for retry
      user.name = userData.name;
      user.password = hashedPassword;
      await user.save();
    } else {
      user = new this.userModel({
        ...userData,
        email: cleanEmail,
        password: hashedPassword,
        role: UserRole.USER,
        status: UserStatus.OFF,
        assignedBusId: null,
        isVerified: false,
      });
      await user.save();
    }

    // Generate 6-digit verification code
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Save to Redis for 15 minutes (900 seconds)
    await this.redis.set(`verify_otp:${cleanEmail}`, otp, 'EX', 900);

    // Send email
    try {
      await this.mailerService.sendMail({
        to: cleanEmail,
        subject: 'លេខកូដផ្ទៀងផ្ទាត់គណនី - KH-Map',
        text: `លេខកូដផ្ទៀងផ្ទាត់របស់អ្នកគឺ: ${otp}`,
      });
    } catch (err) {
      console.error('Failed to send registration verification mail:', err);
    }

    return {
      message: 'លេខកូដផ្ទៀងផ្ទាត់ត្រូវបានផ្ញើ (Verification code sent)',
      email: cleanEmail,
    };
  }

  async createFromFirebase(payload: {
    email: string;
    name: string;
    firebaseUid: string;
  }) {
    const { email, name, firebaseUid } = payload;
    const cleanEmail = email.trim().toLowerCase();

    let user = await this.userModel.findOne({ email: cleanEmail }).exec();
    if (!user) {
      user = new this.userModel({
        name,
        email: cleanEmail,
        firebaseUid,
        isVerified: true,
        role: UserRole.USER,
        status: UserStatus.OFF,
        assignedBusId: null,
      });
      await user.save();
    } else {
      user.firebaseUid = firebaseUid;
      user.isVerified = true;
      await user.save();
    }
    return user;
  }

  // Admin-only: change a user's role. When demoting a driver, clear the
  // bus link on both sides so the user can't operate their previous bus —
  // admin must explicitly re-assign if they re-promote later.
  async setRole(userId: Types.ObjectId, role: UserRole) {
    const user = await this.userModel.findById(userId).exec();
    if (!user) throw new NotFoundException('User not found');

    const wasDriver = user.role === UserRole.DRIVER;
    const previousBusId = user.assignedBusId;
    user.role = role;

    if (wasDriver && role !== UserRole.DRIVER) {
      user.assignedBusId = null;
      user.status = UserStatus.OFF;
      if (previousBusId) {
        await this.busModel
          .updateOne({ _id: previousBusId }, { assignedDriverId: null })
          .exec();
      }
    }

    return user.save();
  }

  async findById(userId: Types.ObjectId) {
    return this.userModel.findById(userId).exec();
  }

  // Bind/unbind a driver to a bus and keep both sides of the relationship
  // consistent. Pass busId=null to unassign. Throws if:
  //   - user doesn't exist or isn't a driver
  //   - bus doesn't exist
  //   - bus is already assigned to a different driver (admin must unassign
  //     the previous driver first — explicit is safer than implicit reassign)
  //   - either side has a trip in progress (see the guards below)
  async assignBusToDriver(
    driverId: Types.ObjectId,
    busId: Types.ObjectId | null,
  ) {
    const driver = await this.userModel.findById(driverId).exec();
    if (!driver) throw new NotFoundException('Driver not found');
    if (driver.role !== UserRole.DRIVER) {
      throw new BadRequestException('Target user is not a driver');
    }

    const previousBusId = driver.assignedBusId;

    // Is this call actually changing anything? Re-assigning a driver to the bus
    // they already have is a no-op and shouldn't trip the guards below.
    const changesAssignment =
      (previousBusId?.toString() ?? null) !== (busId?.toString() ?? null);

    if (changesAssignment) {
      // Guard 1 — the driver is mid-trip.
      //
      // Location publishes are resolved per message as
      // driver -> assignedBusId -> in-progress trip on that bus. Moving the
      // driver now would silently redirect their GPS to a different trip while
      // the one they are physically driving stops updating and goes stale until
      // its Redis TTL expires.
      const driverActiveTrip = await this.busTripModel
        .findOne({ driver: driverId, status: 'in-progress' })
        .exec();
      if (driverActiveTrip) {
        throw new ConflictException(
          'Driver has a trip in progress — cancel it before reassigning',
        );
      }

      // Guard 2 — the target bus is mid-trip under someone else.
      //
      // Only trips with a driver stamped count: in simulation mode the
      // dispatcher runs trips with `driver: null`, and blocking assignment on
      // those would make it impossible to onboard a driver onto a simulated
      // fleet.
      if (busId) {
        const busActiveTrip = await this.busTripModel
          .findOne({
            bus: busId,
            status: 'in-progress',
            driver: { $ne: null },
          })
          .exec();
        if (
          busActiveTrip &&
          busActiveTrip.driver?.toString() !== driverId.toString()
        ) {
          throw new ConflictException(
            'That bus has a trip in progress under another driver — cancel it first',
          );
        }
      }
    }

    if (busId === null) {
      driver.assignedBusId = null;
      driver.status = UserStatus.OFF;
      await driver.save();
      if (previousBusId) {
        await this.busModel
          .updateOne({ _id: previousBusId }, { assignedDriverId: null })
          .exec();
      }
      return driver;
    }

    const bus = await this.busModel.findById(busId).exec();
    if (!bus) throw new NotFoundException('Bus not found');
    if (
      bus.assignedDriverId &&
      bus.assignedDriverId.toString() !== driverId.toString()
    ) {
      throw new ConflictException(
        'Bus is already assigned to another driver — unassign first',
      );
    }

    driver.assignedBusId = busId;
    await driver.save();

    if (previousBusId && previousBusId.toString() !== busId.toString()) {
      await this.busModel
        .updateOne({ _id: previousBusId }, { assignedDriverId: null })
        .exec();
    }
    await this.busModel
      .updateOne({ _id: busId }, { assignedDriverId: driverId })
      .exec();

    return driver;
  }

  async setStatus(userId: Types.ObjectId, status: UserStatus) {
    return this.userModel
      .findByIdAndUpdate(userId, { status }, { new: true })
      .exec();
  }

  // Generate a fresh MQTT password for the driver, store only its bcrypt hash,
  // and return the plaintext. This is the one moment the plaintext exists in
  // a response — the driver app must capture it on this call. Subsequent
  // calls rotate it (previous credential is immediately invalid). Caller
  // should already have verified the user is a driver.
  async rotateMqttPassword(driverId: Types.ObjectId): Promise<string> {
    const user = await this.userModel.findById(driverId).exec();
    if (!user) throw new NotFoundException('Driver not found');
    if (user.role !== UserRole.DRIVER) {
      throw new BadRequestException(
        'Only drivers can request MQTT credentials',
      );
    }
    // 32 bytes of entropy is plenty; base64url keeps the string URL/header
    // safe and avoids the `=` padding that some MQTT clients mishandle.
    const plaintext = randomBytes(32).toString('base64url');
    user.mqttPasswordHash = await bcrypt.hash(plaintext, 10);
    await user.save();
    return plaintext;
  }

  // Used by the MQTT auth HTTP plugin endpoints. Returns the User document
  // (with mqttPasswordHash visible) so the auth handler can bcrypt.compare
  // — NEVER expose this method via a public controller.
  async findRawById(userId: Types.ObjectId) {
    return this.userModel.findById(userId).exec();
  }

  async login(loginDto: LoginDto) {
    const { email, password } = loginDto;
    const cleanEmail = email.trim().toLowerCase();

    const user = await this.userModel.findOne({ email: cleanEmail }).exec();

    if (
      !user ||
      !user.password ||
      !(await bcrypt.compare(password, user.password))
    ) {
      throw new UnauthorizedException(
        'អ៊ីមែល ឬលេខសម្ងាត់មិនត្រឹមត្រូវ (Invalid email or password)',
      );
    }

    const payload = {
      sub: user._id,
      email: user.email,
      role: user.role,
      name: user.name,
    };

    return {
      access_token: this.jwtService.sign(payload),
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
      },
    };
  }

  async verifyRegistration(email: string, otp: string) {
    const cleanEmail = email.trim().toLowerCase();
    const savedOtp = await this.redis.get(`verify_otp:${cleanEmail}`);
    if (!savedOtp || savedOtp !== otp.trim()) {
      throw new BadRequestException(
        'លេខកូដមិនត្រឹមត្រូវ ឬហួសកំណត់ (Invalid or expired code)',
      );
    }
    const user = await this.userModel.findOne({ email: cleanEmail }).exec();
    if (!user) throw new NotFoundException('រកមិនឃើញគណនីទេ (User not found)');

    user.isVerified = true;
    await user.save();
    await this.redis.del(`verify_otp:${cleanEmail}`);

    const payload = {
      sub: user._id,
      email: user.email,
      role: user.role,
      name: user.name,
    };

    return {
      access_token: this.jwtService.sign(payload),
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
      },
    };
  }

  async resendVerificationCode(email: string) {
    const cleanEmail = email.trim().toLowerCase();
    const user = await this.userModel.findOne({ email: cleanEmail }).exec();
    if (!user) throw new NotFoundException('រកមិនឃើញគណនីទេ (User not found)');
    if (user.isVerified) {
      throw new BadRequestException(
        'គណនីនេះត្រូវបានផ្ទៀងផ្ទាត់រួចហើយ (Account is already verified)',
      );
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await this.redis.set(`verify_otp:${cleanEmail}`, otp, 'EX', 900);

    try {
      await this.mailerService.sendMail({
        to: cleanEmail,
        subject: 'លេខកូដផ្ទៀងផ្ទាត់គណនី - KH-Map',
        text: `លេខកូដផ្ទៀងផ្ទាត់ថ្មីរបស់អ្នកគឺ: ${otp}`,
      });
    } catch (err) {
      console.error('Failed to resend verification mail:', err);
    }

    return { message: 'លេខកូដត្រូវបានផ្ញើឡើងវិញជោគជ័យ' };
  }

  async googleLogin(idToken: string) {
    try {
      let email: string;
      let name: string;
      let googleId: string;

      if (
        process.env.NODE_ENV === 'development' &&
        idToken.startsWith('mock_google_')
      ) {
        email = idToken.substring('mock_google_'.length).trim().toLowerCase();
        name = email.split('@')[0];
        googleId = 'mock_google_id_' + Date.now();
      } else {
        // 1. Call Google Token Info API to verify
        const verifyUrl = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`;
        const response = await fetch(verifyUrl);
        if (!response.ok) {
          throw new UnauthorizedException('Google token validation failed');
        }
        const payload = await response.json();

        if (
          payload.email_verified !== 'true' &&
          payload.email_verified !== true
        ) {
          throw new UnauthorizedException('Google email not verified');
        }

        email = payload.email.trim().toLowerCase();
        name = payload.name || email.split('@')[0];
        googleId = payload.sub;
      }

      // 2. Find or create user
      let user = await this.userModel.findOne({ email }).exec();
      if (user) {
        let saveNeeded = false;
        if (!user.googleId) {
          user.googleId = googleId;
          saveNeeded = true;
        }
        if (!user.isVerified) {
          user.isVerified = true;
          saveNeeded = true;
        }
        if (saveNeeded) {
          await user.save();
        }
      } else {
        user = new this.userModel({
          name,
          email,
          role: UserRole.USER,
          status: UserStatus.OFF,
          assignedBusId: null,
          googleId,
          isVerified: true,
        });
        await user.save();
      }

      // 3. Generate token
      const jwtPayload = {
        sub: user._id,
        email: user.email,
        role: user.role,
        name: user.name,
      };

      return {
        access_token: this.jwtService.sign(jwtPayload),
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
        },
      };
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException(
        'Failed to login with Google: ' + (error as Error).message,
      );
    }
  }

  /**
   * One-click sign-in with Firebase. The frontend authenticates the user with
   * the Firebase client SDK (Google / Apple / email-link / etc.), obtains a
   * Firebase ID token, and posts it here. We verify the token with the Firebase
   * Admin SDK, find-or-create the matching Mongo user (verified, no password),
   * and return OUR own app JWT — so from this point on the client uses the same
   * `access_token` as every other sign-in path and hits the same JwtAuthGuard.
   *
   * Only the project ID is needed to VERIFY tokens; the Admin SDK fetches
   * Google's public signing keys over HTTP. A service-account credential is
   * only required for privileged operations we don't perform here.
   */
  async firebaseLogin(idToken: string) {
    if (!idToken) {
      throw new BadRequestException('idToken is required');
    }

    if (getApps().length === 0) {
      initializeApp({
        projectId: process.env.FIREBASE_PROJECT_ID || 'khmapauth',
      });
    }

    let decoded: DecodedIdToken;
    try {
      decoded = await getAuth().verifyIdToken(idToken);
    } catch {
      throw new UnauthorizedException(
        'Firebase token មិនត្រឹមត្រូវ ឬហួសកំណត់ (Invalid or expired Firebase token)',
      );
    }

    const email = decoded.email?.trim().toLowerCase();
    if (!email) {
      throw new UnauthorizedException(
        'Firebase token គ្មានអ៊ីមែល (Firebase token has no email)',
      );
    }

    const name =
      typeof decoded.name === 'string' && decoded.name.trim()
        ? decoded.name.trim()
        : email.split('@')[0];

    const user = await this.createFromFirebase({
      email,
      name,
      firebaseUid: decoded.uid,
    });

    const payload = {
      sub: user._id,
      email: user.email,
      role: user.role,
      name: user.name,
    };

    return {
      access_token: this.jwtService.sign(payload),
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
      },
    };
  }

  async findByEmail(email: string) {
    return this.userModel.findOne({ email }).exec();
  }

  /**
   * Count users by role, optionally narrowed by status (on/off shift).
   * Used by the admin dashboard for at-a-glance fleet visibility.
   */
  async countByRole(role: UserRole, status?: UserStatus): Promise<number> {
    const query: Record<string, unknown> = { role };
    if (status) query.status = status;
    return this.userModel.countDocuments(query).exec();
  }

  async forgotPassword(email: string) {
    const user = await this.userModel.findOne({ email });
    if (!user)
      throw new NotFoundException('រកមិនឃើញអ៊ីមែលនេះទេ (Email not found)');

    // 1. Generate 6-digit code
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // 2. Save to Redis for 10 minutes
    await this.redis.set(`reset_otp:${email}`, otp, 'EX', 600);

    // 3. Send Email
    await this.mailerService.sendMail({
      to: email,
      subject: 'លេខកូដផ្លាស់ប្តូរលេខសម្ងាត់ - KH-Map',
      text: `លេខកូដរបស់អ្នកគឺ: ${otp}`,
    });

    return { message: 'លេខកូដត្រូវបានផ្ញើទៅកាន់អ៊ីមែលរបស់អ្នក' };
  }

  async resetPassword(email: string, otp: string, newPassword: string) {
    const cleanEmail = email.trim().toLowerCase();
    const cleanOtp = otp.trim();

    // 1. Get the code from Redis
    const redisKey = `reset_otp:${cleanEmail}`;
    const savedOtp = await this.redis.get(redisKey);

    if (!savedOtp) {
      throw new BadRequestException(
        'លេខកូដបានហួសកំណត់ (Code expired or not found)',
      );
    }

    if (savedOtp !== cleanOtp) {
      throw new BadRequestException('លេខកូដមិនត្រឹមត្រូវ (Invalid code)');
    }

    // 2. Hash and update (rest of your logic...)
    const salt = await bcrypt.genSalt();
    const hashedPassword = await bcrypt.hash(newPassword, salt);
    await this.userModel.updateOne(
      { email: cleanEmail },
      { password: hashedPassword },
    );

    await this.redis.del(redisKey);
    return { message: 'Success' };
  }

  // ─── CRUD ──────────────────────────────────────────────────────────────────

  /**
   * Strip credential fields before a user document leaves the service. Every
   * CRUD method below returns through this — `password` and `mqttPasswordHash`
   * are bcrypt hashes, and hashes are still worth brute-forcing offline.
   */
  private sanitize(user: UserDocument) {
    const obj = user.toObject() as unknown as Record<string, unknown>;
    delete obj.password;
    delete obj.mqttPasswordHash;
    return obj;
  }

  /** Fields excluded from list/read queries — the projection form of sanitize. */
  private static readonly PUBLIC_PROJECTION = '-password -mqttPasswordHash';

  /**
   * Admin-created account. Skips the email OTP that `create()` requires:
   * `isVerified` is true from the start, so a driver can be onboarded and log
   * in without waiting on a mailbox.
   */
  async adminCreate(dto: {
    name: string;
    email: string;
    password: string;
    role?: UserRole;
  }) {
    const cleanEmail = dto.email.trim().toLowerCase();

    const existing = await this.userModel.findOne({ email: cleanEmail }).exec();
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    const salt = await bcrypt.genSalt();
    const user = new this.userModel({
      name: dto.name,
      email: cleanEmail,
      password: await bcrypt.hash(dto.password, salt),
      role: dto.role ?? UserRole.USER,
      status: UserStatus.OFF,
      assignedBusId: null,
      isVerified: true,
    });
    await user.save();
    return this.sanitize(user);
  }

  /**
   * Paginated user list for the admin dashboard. Without this an admin has no
   * way to discover the `:id` that every other admin endpoint requires.
   */
  async findAll(query: {
    page?: number;
    limit?: number;
    role?: UserRole;
    status?: UserStatus;
    search?: string;
  }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const filter: Record<string, unknown> = {};
    if (query.role) filter.role = query.role;
    if (query.status) filter.status = query.status;
    if (query.search) {
      // Escape regex metacharacters — an unescaped search box is a trivial
      // ReDoS, and a lone "(" would otherwise throw on an invalid pattern.
      const safe = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { name: { $regex: safe, $options: 'i' } },
        { email: { $regex: safe, $options: 'i' } },
      ];
    }

    const [data, total] = await Promise.all([
      this.userModel
        .find(filter)
        .select(UsersService.PUBLIC_PROJECTION)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.userModel.countDocuments(filter).exec(),
    ]);

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    };
  }

  /** Single user, credentials stripped. */
  async findOnePublic(userId: Types.ObjectId) {
    const user = await this.userModel
      .findById(userId)
      .select(UsersService.PUBLIC_PROJECTION)
      .exec();
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  /**
   * Admin edit. Only the fields present in `dto` are touched.
   *
   * A role change routes through the same demotion logic as `setRole` — an
   * ex-driver must not keep a bus link, on either side of the relationship.
   */
  async adminUpdate(
    userId: Types.ObjectId,
    dto: {
      name?: string;
      email?: string;
      password?: string;
      role?: UserRole;
      status?: UserStatus;
      isVerified?: boolean;
    },
  ) {
    const user = await this.userModel.findById(userId).exec();
    if (!user) throw new NotFoundException('User not found');

    if (dto.email !== undefined) {
      const cleanEmail = dto.email.trim().toLowerCase();
      if (cleanEmail !== user.email) {
        const taken = await this.userModel
          .findOne({ email: cleanEmail, _id: { $ne: userId } })
          .exec();
        if (taken) throw new ConflictException('Email already registered');
        user.email = cleanEmail;
      }
    }

    if (dto.name !== undefined) user.name = dto.name;
    if (dto.isVerified !== undefined) user.isVerified = dto.isVerified;
    if (dto.status !== undefined) user.status = dto.status;

    if (dto.password !== undefined) {
      const salt = await bcrypt.genSalt();
      user.password = await bcrypt.hash(dto.password, salt);
    }

    if (dto.role !== undefined && dto.role !== user.role) {
      const wasDriver = user.role === UserRole.DRIVER;
      const previousBusId = user.assignedBusId;
      user.role = dto.role;

      if (wasDriver && dto.role !== UserRole.DRIVER) {
        user.assignedBusId = null;
        user.status = UserStatus.OFF;
        if (previousBusId) {
          await this.busModel
            .updateOne({ _id: previousBusId }, { assignedDriverId: null })
            .exec();
        }
      }
    }

    await user.save();
    return this.sanitize(user);
  }

  /**
   * Self-service profile edit. Narrower than the admin path by design — a user
   * cannot change their own role, status, or email here.
   *
   * Changing the password requires the current one, so a stolen JWT alone
   * can't be used to lock the real owner out of their account.
   */
  async updateOwnProfile(
    userId: Types.ObjectId,
    dto: { name?: string; currentPassword?: string; newPassword?: string },
  ) {
    const user = await this.userModel.findById(userId).exec();
    if (!user) throw new NotFoundException('User not found');

    if (dto.name !== undefined) user.name = dto.name;

    if (dto.newPassword !== undefined) {
      if (!user.password) {
        // Google/Firebase accounts were provisioned without one, so there is
        // nothing to verify against. They set a first password through the
        // forgot-password flow, which proves control of the mailbox instead.
        throw new BadRequestException(
          'This account has no password set — use forgot-password instead',
        );
      }
      const ok = await bcrypt.compare(dto.currentPassword ?? '', user.password);
      if (!ok) throw new UnauthorizedException('Current password is incorrect');

      const salt = await bcrypt.genSalt();
      user.password = await bcrypt.hash(dto.newPassword, salt);
    }

    await user.save();
    return this.sanitize(user);
  }

  /**
   * Hard delete. Three guards, each protecting against a state you cannot
   * recover from through the API:
   *
   *   1. An admin cannot delete themselves (immediate self-lockout).
   *   2. The last admin cannot be deleted (nobody could administer anything).
   *   3. A driver mid-trip is refused — cancel the trip first. Deleting them
   *      would leave an in-progress trip whose driver no longer exists, with a
   *      bus that stops reporting and no way to close it out.
   *
   * A deleted driver's finished trips keep their `driver` ObjectId, so history
   * stays intact; populating it simply yields null.
   */
  async remove(userId: Types.ObjectId, actingAdminId: string) {
    if (userId.toString() === actingAdminId) {
      throw new BadRequestException('You cannot delete your own account');
    }

    const user = await this.userModel.findById(userId).exec();
    if (!user) throw new NotFoundException('User not found');

    if (user.role === UserRole.ADMIN) {
      const admins = await this.userModel
        .countDocuments({ role: UserRole.ADMIN })
        .exec();
      if (admins <= 1) {
        throw new ConflictException(
          'Cannot delete the last admin — promote another user first',
        );
      }
    }

    if (user.role === UserRole.DRIVER) {
      const activeTrip = await this.busTripModel
        .findOne({ driver: userId, status: 'in-progress' })
        .exec();
      if (activeTrip) {
        throw new ConflictException(
          'Driver has a trip in progress — cancel it before deleting',
        );
      }
      if (user.assignedBusId) {
        await this.busModel
          .updateOne({ _id: user.assignedBusId }, { assignedDriverId: null })
          .exec();
      }
    }

    await this.userModel.deleteOne({ _id: userId }).exec();
    return { message: 'User deleted', id: userId.toString() };
  }
}
