import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsOptional,
} from 'class-validator';

/**
 * Body for POST /transit/admin/suggest-path.
 *
 * `vias` are optional steering points: the admin drops them on the specific
 * road the bus takes when Valhalla's default (fastest) road is not the real
 * corridor. The returned polyline passes through every via, road-snapped.
 */
export class SuggestPathDto {
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  from!: [number, number]; // [lng, lat]

  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  to!: [number, number]; // [lng, lat]

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  vias?: [number, number][]; // [[lng, lat], ...]
}
