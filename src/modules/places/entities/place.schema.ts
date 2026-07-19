import { Prop, raw, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { BaseEntity } from '../../../shared/database/base.entity';

export type PlaceDocument = HydratedDocument<Place>;

export type GeoJsonPoint = {
  type: 'Point';
  coordinates: [number, number]; // [longitude, latitude]
};

@Schema({ timestamps: true, collection: 'places' })
export class Place extends BaseEntity {
  @Prop({ required: true, type: String })
  nameInKhmer: string;

  @Prop({ required: true, type: String })
  nameInLatin: string;

  @Prop({ type: Types.ObjectId, ref: 'PlaceCategory', default: null })
  category: Types.ObjectId | null;

  @Prop(
    raw({
      type: { type: String, enum: ['Point'], required: true },
      coordinates: { type: [Number], required: true },
    }),
  )
  location: GeoJsonPoint;

  @Prop({ type: Number, default: null })
  ratingCount: number | null;

  @Prop({ type: Number, min: 1.0, max: 5.0, default: null })
  averageRating: number | null;

  @Prop({ required: false, type: [String], default: [] })
  photos: string[];
}

export const PlaceSchema = SchemaFactory.createForClass(Place);
PlaceSchema.index({ location: '2dsphere' });
