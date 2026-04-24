import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from './entities/user.schema';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { CreateUserDto } from './dto/create-user.dto';
import { LoginDto } from './dto/login.dto';
import { JwtService } from '@nestjs/jwt';
import { REDIS_CLIENT } from 'src/shared/redis/redis.module';
import Redis from 'ioredis';
import { MailerService } from '@nestjs-modules/mailer';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly mailerService: MailerService,
    private jwtService: JwtService,
  ) {}

  async create(userData: CreateUserDto) {
    const salt = await bcrypt.genSalt();
    const hashedPassword = await bcrypt.hash(userData.password, salt);

    const newUser = new this.userModel({
      ...userData,
      password: hashedPassword,
    });
    return newUser.save();
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

  async forgotPassword(email: string) {
    const user = await this.userModel.findOne({ email });
    if (!user)
      throw new NotFoundException('រកមិនឃើញអ៊ីមែលនេះទេ (Email not found)');

    // 1. Generate 6-digit code
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // 2. Save to Redis for 10 minutes
    await this.redis.set(`reset_otp:${email}`, otp, 'EX', 600);

    // 3. Send Email
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
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

    // --- DEBUG LOGS ---
    console.log('--- RESET PASSWORD ATTEMPT ---');
    console.log('Searching Redis Key:', redisKey);
    console.log('OTP from Flutter:', `"${cleanOtp}"`);
    console.log('OTP found in Redis:', `"${savedOtp}"`);
    // ------------------

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
