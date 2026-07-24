import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { BaseEntity } from '../../../shared/database/base.entity';

export type FavoriteDocument = HydratedDocument<Favorite>;

@Schema({ timestamps: true, collection: 'favorites' })
export class Favorite extends BaseEntity {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ required: true, type: String })
  placeId: string;

  @Prop({ required: true, type: String })
  name: string;

  @Prop({ required: true, type: String, default: 'Place' })
  categoryName: string;

  @Prop({ required: true, type: Number })
  latitude: number;

  @Prop({ required: true, type: Number })
  longitude: number;

  @Prop({ type: String, default: null })
  photo: string | null;

  @Prop({ type: Number, default: null })
  averageRating: number | null;

  @Prop({ type: Number, default: null })
  ratingCount: number | null;

  @Prop({ type: Date, default: Date.now })
  favoritedAt: Date;
}

export const FavoriteSchema = SchemaFactory.createForClass(Favorite);
FavoriteSchema.index({ userId: 1, placeId: 1 }, { unique: true });
FavoriteSchema.index({ userId: 1, favoritedAt: -1 });
