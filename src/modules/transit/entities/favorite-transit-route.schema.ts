import { Prop, Schema, SchemaFactory, raw } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { BaseEntity } from '../../../shared/database/base.entity';

export type FavoriteTransitRouteDocument =
  HydratedDocument<FavoriteTransitRoute>;

export type SkeletonEndpoint = {
  name?: string;
  coordinates: [number, number]; // [lng, lat]
};

export type SkeletonLeg = {
  route: Types.ObjectId;
  boardStop: Types.ObjectId;
  alightStop: Types.ObjectId;
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
  origin!: SkeletonEndpoint;

  @Prop(
    raw({
      name: { type: String, default: null },
      coordinates: { type: [Number], required: true },
    }),
  )
  destination!: SkeletonEndpoint;

  @Prop({
    type: [
      raw({
        route: { type: Types.ObjectId, ref: 'BusRoute', required: true },
        boardStop: { type: Types.ObjectId, ref: 'Place', required: true },
        alightStop: { type: Types.ObjectId, ref: 'Place', required: true },
      }),
    ],
    required: true,
    validate: {
      validator: (v: unknown[]) => Array.isArray(v) && v.length > 0,
      message: 'A favorite must include at least one transit leg.',
    },
  })
  legs!: SkeletonLeg[];
}

export const FavoriteTransitRouteSchema =
  SchemaFactory.createForClass(FavoriteTransitRoute);
FavoriteTransitRouteSchema.index({ user: 1, createdAt: -1 });
