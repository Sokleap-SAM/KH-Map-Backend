import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from './entities/user.schema';
import { Bus, BusSchema } from '../transit/entities/bus.schema';
import { BusTrip, BusTripSchema } from '../transit/entities/bus-trip.schema';
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
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Bus.name, schema: BusSchema },
      // Registering the schema directly rather than importing TransitModule —
      // TransitModule imports this one, so that would be circular. Used only to
      // block deleting a driver who has a trip in progress.
      { name: BusTrip.name, schema: BusTripSchema },
    ]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
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
        signOptions: { expiresIn: '1d' },
      }),
    }),
  ],
  providers: [UsersService, JwtStrategy, RolesGuard],
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule {}
