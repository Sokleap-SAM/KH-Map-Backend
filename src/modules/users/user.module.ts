import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from './entities/user.schema';
import { Module } from '@nestjs/common';
import { UsersController } from './user.controller';
import { UsersService } from './user.service';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from './strategies/jwt.strategy';
import { RolesGuard } from '../../common/guards/roles.guard';
import { MailerModule } from '@nestjs-modules/mailer';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    MailerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        transport: {
          host: 'smtp.gmail.com', // Change this to your provider
          port: 587,
          secure: false,
          auth: {
            user: config.get<string>('EMAIL_USER'), // Add to your .env
            pass: config.get<string>('EMAIL_PASS'), // Add to your .env
          },
        },
        defaults: {
          from: '"KH-Map Support" <no-reply@khmap.com>',
        },
      }),
    }),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET') || 'SUPER_SECRET_KEY',
        signOption: { expiresIn: '1d' },
      }),
    }),
  ],
  providers: [UsersService, JwtStrategy, RolesGuard],
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule {}
