import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class CreateBusRouteDto {
  @IsOptional()
  @IsBoolean()
  isLine?: boolean;

  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  @IsIn(['active', 'inactive'])
  status?: string;

  /** Average minutes between successive buses (headway). Used as fallback wait = headway / 2. */
  @IsOptional()
  @IsInt()
  @Min(1)
  headwayMinutes?: number;
}
