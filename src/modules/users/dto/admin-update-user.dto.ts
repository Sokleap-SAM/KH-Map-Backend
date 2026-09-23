import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  MinLength,
} from 'class-validator';
import { UserRole, UserStatus } from '../enums/role.enum';

/**
 * Admin edit of any user. Every field is optional — only what's sent is
 * changed.
 *
 * `role` is accepted here for convenience, but it routes through the same
 * `setRole` logic as `PATCH /users/admin/users/:id/role`, so demoting a driver
 * still unassigns their bus on both sides of the relationship rather than
 * leaving a dangling link.
 *
 * Password is set directly (no current-password check) because an admin
 * resetting an account is a different operation from a user changing their own
 * — see UpdateProfileDto for the self-service path.
 */
export class AdminUpdateUserDto {
  @IsOptional()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @MinLength(8)
  password?: string;

  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  /** Driver shift state. Meaningless for riders and admins. */
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  /** Lets an admin unblock a user stuck without a verification email. */
  @IsOptional()
  @IsBoolean()
  isVerified?: boolean;
}
