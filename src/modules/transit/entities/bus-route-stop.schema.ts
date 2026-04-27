import { Prop, raw, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { BaseEntity } from '../../../shared/database/base.entity';

export type BusRouteStopDocument = HydratedDocument<BusRouteStop>;

export type GeoJsonLineString = {
  type: 'LineString';
  coordinates: [number, number][]; // [longitude, latitude][]
};

@Schema({ timestamps: true, collection: 'bus_route_stops' })
export class BusRouteStop extends BaseEntity {
  @Prop({ required: true, type: Types.ObjectId, ref: 'BusRoute' })
  route?: Types.ObjectId;

  @Prop({ required: true, type: Types.ObjectId, ref: 'Place' })
  stop?: Types.ObjectId;

  @Prop({ required: true, type: Number })
  stopOrder?: number;

  @Prop({ type: Number, default: null })
  distanceFromPrevious?: number | null;

  @Prop({ type: Number, default: null })
  estimatedTimeFromPrevious?: number | null;

  /**
   * Road geometry from the previous stop to this stop.
   * Use multiple coordinates to trace curves/turns along the actual road.
   * Null for the first stop (no previous segment).
   */
  @Prop(
    raw({
      type: { type: String, enum: ['LineString'] },
      coordinates: { type: [[Number]] },
    }),
  )
  segmentPath?: GeoJsonLineString;
}

export const BusRouteStopSchema = SchemaFactory.createForClass(BusRouteStop);
BusRouteStopSchema.index({ route: 1, stopOrder: 1 }, { unique: true });
BusRouteStopSchema.index({ stop: 1 });
