import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { UserRole, UserStatus } from '../enums/role.enum';

/**
 * Query for the admin user list. Query strings arrive as text, so `@Type`
 * coerces the numerics — the global ValidationPipe runs with `transform: true`,
 * which is what makes that work.
 */
export class ListUsersQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  /** Capped so a single call can't pull the whole collection into memory. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  /** Case-insensitive partial match against name and email. */
  @IsOptional()
  @IsString()
  search?: string;
}
