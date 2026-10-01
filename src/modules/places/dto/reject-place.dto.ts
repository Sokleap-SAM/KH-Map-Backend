import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Body for PATCH /places/requests/:id/reject. The admin must explain why the
 * request is rejected so the submitter can see the reason and fix/re-submit.
 */
export class RejectPlaceDto {
  @IsString()
  @IsNotEmpty({ message: 'A rejection reason is required' })
  @MaxLength(1000)
  reason!: string;
}
