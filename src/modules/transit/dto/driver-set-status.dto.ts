import { IsEnum } from 'class-validator';
import { UserStatus } from '../../users/enums/role.enum';

export class DriverSetStatusDto {
  @IsEnum(UserStatus)
  status!: UserStatus;
}
