import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { BaseEntity } from '../../../shared/database/base.entity';

export type PlaceRatingDocument = HydratedDocument<PlaceRating>;

@Schema({ timestamps: true, collection: 'place_ratings' })
export class PlaceRating extends BaseEntity {
  @Prop({ required: true, type: String, ref: 'User' })
  userId!: string;

  @Prop({ required: true, type: String, ref: 'Place' })
  placeId!: string;

  @Prop({ type: String, default: null })
  comment!: string | null;

  @Prop({ required: true, type: Number, min: 1, max: 5 })
  score!: number;
}

export const PlaceRatingSchema = SchemaFactory.createForClass(PlaceRating);
PlaceRatingSchema.index({ placeId: 1, userId: 1 });
