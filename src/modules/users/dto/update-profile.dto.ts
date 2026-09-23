import { IsNotEmpty, IsOptional, MinLength, ValidateIf } from 'class-validator';

/**
 * Self-service profile edit — what a logged-in user may change about their own
 * account.
 *
 * Deliberately narrower than the admin DTO: no `role`, no `status`, no
 * `isVerified`, no `email`. Role and status are privilege, and letting a user
 * rewrite their own email would hand them another account's password-reset
 * flow. Email changes belong behind a re-verification round trip that doesn't
 * exist yet.
 *
 * Changing the password requires proving the current one. That closes the
 * session-hijack path where a stolen JWT could otherwise lock the real owner
 * out of their account.
 */
export class UpdateProfileDto {
  @IsOptional()
  @IsNotEmpty()
  name?: string;

  /** Required whenever `newPassword` is present. */
  @ValidateIf((o: UpdateProfileDto) => o.newPassword !== undefined)
  @IsNotEmpty({ message: 'currentPassword is required to change the password' })
  currentPassword?: string;

  @IsOptional()
  @MinLength(8)
  newPassword?: string;
}
