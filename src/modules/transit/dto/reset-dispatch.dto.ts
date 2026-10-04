import { IsIn } from 'class-validator';

/**
 * Explicit confirmation for the fleet reset.
 *
 * The endpoint is admin-only, which settles *who* may call it, but not whether
 * a given call was meant. A reset is irreversible and takes one empty POST, so
 * a stale API-client tab, a bookmarked request or a replayed curl from shell
 * history is enough to wipe the fleet. Requiring a literal string in the body
 * costs an admin nothing deliberate and makes an accidental reset essentially
 * impossible.
 */
export class ResetDispatchDto {
  @IsIn(['RESET_FLEET'], {
    message: 'confirm must be the exact string "RESET_FLEET"',
  })
  confirm!: string;
}
