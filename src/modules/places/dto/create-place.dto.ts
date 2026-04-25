import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { Types } from 'mongoose';

export class CreatePlaceDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @Transform(({ value }) =>
    value ? new Types.ObjectId(value as string) : null,
  )
  category?: Types.ObjectId | null;

  /**
   * Location as [longitude, latitude] — e.g. [104.9565, 11.4670]
   * Stored internally as GeoJSON Point.
   */
  @Transform(({ value }) => {
    let coords: number[] = value as number[];
    if (typeof value === 'string') {
      try {
        coords = JSON.parse(value) as number[];
      } catch {
        return value;
      }
    }
    return coords.map(Number);
  })
  @IsArray()
  @ArrayMinSize(2, { message: 'location must be [longitude, latitude]' })
  @ArrayMaxSize(2, {
    message: 'location must be [longitude, latitude] — do not include altitude',
  })
  @IsNumber({}, { each: true })
  @Min(-180, {
    each: true,
    message:
      'longitude out of range — make sure order is [longitude, latitude]',
  })
  @Max(180, {
    each: true,
    message: 'latitude out of range — make sure order is [longitude, latitude]',
  })
  location!: [number, number];
}
