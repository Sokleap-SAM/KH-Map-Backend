import { Type } from 'class-transformer';
import { IsLatitude, IsLongitude } from 'class-validator';

export class SuggestPathDto {
  @Type(() => Number)
  @IsLongitude()
  fromLng!: number;

  @Type(() => Number)
  @IsLatitude()
  fromLat!: number;

  @Type(() => Number)
  @IsLongitude()
  toLng!: number;

  @Type(() => Number)
  @IsLatitude()
  toLat!: number;
}
