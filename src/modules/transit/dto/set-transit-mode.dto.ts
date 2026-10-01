import { IsEnum } from 'class-validator';
import { TransitMode } from '../../app-settings/enums/transit-mode.enum';

export class SetTransitModeDto {
  @IsEnum(TransitMode)
  mode!: TransitMode;
}
