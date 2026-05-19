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

  /**
   * Road geometry of the segment ARRIVING at this stop — the path from the
   * previous stop in the route sequence to this one. Use multiple coordinates
   * to trace curves/turns along the actual road. First coordinate should be at
   * the previous stop's location; last coordinate at this stop's location.
   * Null for the first stop in a route (no incoming segment).
   *
   * Both TransitRoutingService (`buildRaptorBusSegment`) and BusSimulationService
   * (`buildSegmentCoords`) read this convention — keep them aligned if changed.
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
