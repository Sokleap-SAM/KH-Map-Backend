import { Prop, raw, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { BaseEntity } from '../../../shared/database/base.entity';

export type BusLocationDocument = HydratedDocument<BusLocation>;

@Schema({ timestamps: true, collection: 'bus_locations' })
export class BusLocation extends BaseEntity {
  /** The physical bus that reported this position */
  @Prop({ required: true, type: Types.ObjectId, ref: 'Bus' })
  bus!: Types.ObjectId;

  /** The active trip this bus is running */
  @Prop({ required: true, type: Types.ObjectId, ref: 'BusTrip' })
  trip!: Types.ObjectId;

  /** The route this bus is serving (denormalized for fast queries) */
  @Prop({ required: true, type: Types.ObjectId, ref: 'BusRoute' })
  route!: Types.ObjectId;

  /** GPS position: [longitude, latitude] */
  @Prop(
    raw({
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number] },
    }),
  )
  location!: { type: 'Point'; coordinates: [number, number] };

  /** Compass heading in degrees (0-360), optional */
  @Prop({ type: Number, default: null })
  heading!: number | null;

  /** Speed in km/h reported by the device, optional */
  @Prop({ type: Number, default: null })
  speed!: number | null;

  /** When the GPS ping was captured on the device */
  @Prop({ required: true, type: Date })
  recordedAt!: Date;
}

export const BusLocationSchema = SchemaFactory.createForClass(BusLocation);

// One document per active trip (BusLocationService.reportLocation upserts on
// this key), so a plain (non-compound) index is enough — no `recordedAt`
// secondary key needed because there's only ever one matching doc per trip.
BusLocationSchema.index({ trip: 1 });
BusLocationSchema.index({ route: 1 });
BusLocationSchema.index({ location: '2dsphere' });

// TTL safety net: if a trip stops being updated (crashed simulator, paused
// service), the document is removed after 24h. Active trips keep their
// `recordedAt` fresh on every persisted update, so they never expire.
// 86400 = BUS_LOCATION_DB_TTL_SECONDS — hard-coded here because Mongoose
// index options must be statically analysable.
BusLocationSchema.index({ recordedAt: 1 }, { expireAfterSeconds: 86400 });
