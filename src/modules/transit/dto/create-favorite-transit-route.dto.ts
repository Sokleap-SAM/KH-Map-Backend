import { Type, Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Types } from 'mongoose';

class FavoriteEndpointDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  coordinates!: [number, number]; // [lng, lat]
}

export class CreateFavoriteTransitRouteDto {
  @IsNotEmpty()
  @Transform(({ value }) => new Types.ObjectId(value as string))
  user!: Types.ObjectId;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  @ValidateNested()
  @Type(() => FavoriteEndpointDto)
  origin!: FavoriteEndpointDto;

  @ValidateNested()
  @Type(() => FavoriteEndpointDto)
  destination!: FavoriteEndpointDto;
}
