import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from './entities/user.schema';
import { Bus, BusDocument } from '../transit/entities/bus.schema';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
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

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    @InjectModel(Bus.name) private busModel: Model<BusDocument>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly mailerService: MailerService,
    private jwtService: JwtService,
  ) {}

  async create(userData: CreateUserDto) {
    const salt = await bcrypt.genSalt();
    const hashedPassword = await bcrypt.hash(userData.password, salt);

    // Role is hard-coded here, never taken from input — public registration
    // creates only normal users. Promotion to driver/admin is admin-only via
    // setRole below.
    const newUser = new this.userModel({
      ...userData,
      password: hashedPassword,
      role: UserRole.USER,
      status: UserStatus.OFF,
      assignedBusId: null,
    });
    return newUser.save();
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

    const user = await this.userModel.findOne({ email }).exec();

    if (!user || !(await bcrypt.compare(password, user.password))) {
      throw new UnauthorizedException('Invalid email or password');
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
}
