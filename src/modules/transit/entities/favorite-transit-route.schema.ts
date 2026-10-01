import { Prop, Schema, SchemaFactory, raw } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { BaseEntity } from '../../../shared/database/base.entity';

export type FavoriteTransitRouteDocument =
  HydratedDocument<FavoriteTransitRoute>;

export type FavoriteEndpoint = {
  name?: string;
  coordinates: [number, number]; // [lng, lat]
};

@Schema({ timestamps: true, collection: 'favorite_transit_routes' })
export class FavoriteTransitRoute extends BaseEntity {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  user!: Types.ObjectId;

  @Prop({ type: String, default: null })
  label?: string | null;

  @Prop(
    raw({
      name: { type: String, default: null },
      coordinates: { type: [Number], required: true },
    }),
  )
  origin!: FavoriteEndpoint;

  @Prop(
    raw({
      name: { type: String, default: null },
      coordinates: { type: [Number], required: true },
    }),
  )
  destination!: FavoriteEndpoint;
}

export const FavoriteTransitRouteSchema =
  SchemaFactory.createForClass(FavoriteTransitRoute);
FavoriteTransitRouteSchema.index({ user: 1, createdAt: -1 });
