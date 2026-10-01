import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  MinLength,
} from 'class-validator';
import { UserRole } from '../enums/role.enum';

/**
 * Admin-created account. Unlike self-registration (`POST /users/register`) this
 * skips the email OTP entirely — the account is created verified and can log in
 * immediately, which is how a driver gets onboarded without waiting on a
 * mailbox. Role is settable here so an admin doesn't have to create the user
 * and then promote them in a second call.
 */
export class AdminCreateUserDto {
  @IsNotEmpty()
  name!: string;

  @IsEmail()
  email!: string;

  @MinLength(8)
  password!: string;

  /** Defaults to `user` when omitted. */
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;
}
