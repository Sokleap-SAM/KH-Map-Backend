import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { BaseEntity } from '../../../shared/database/base.entity';

export type BusRouteDocument = HydratedDocument<BusRoute>;

@Schema({ timestamps: true, collection: 'bus_routes' })
export class BusRoute extends BaseEntity {
  @Prop({ required: true, type: Boolean, default: false })
  isLine!: boolean;

  @Prop({ type: String, default: null })
  code?: string | null;

  @Prop({ type: String, default: null })
  name?: string | null;

  @Prop({ type: String, default: null })
  color?: string | null;

  /**
   * Direction of travel for bidirectional routes that share a `code`.
   * Null for circular/loop routes (`isLine: true`), where direction is
   * meaningless. Routes pair up: (code: "5A", direction: "outbound") and
   * (code: "5A", direction: "inbound") together describe the full Line 5A.
   */
  @Prop({
    type: String,
    enum: ['outbound', 'inbound'],
    default: null,
  })
  direction?: 'outbound' | 'inbound' | null;

  @Prop({
    required: true,
    type: String,
    enum: ['active', 'inactive'],
    default: 'active',
  })
  status!: string;

  /**
   * Average minutes between successive buses on this route (headway).
   * Used as a fallback wait estimate when no live GPS data is available:
   * expected wait = headwayMinutes / 2 (average of uniform distribution).
   */
  @Prop({ type: Number, default: null })
  headwayMinutes?: number | null;
}

export const BusRouteSchema = SchemaFactory.createForClass(BusRoute);
BusRouteSchema.index({ isLine: 1 });
BusRouteSchema.index({ code: 1 }, { sparse: true });
BusRouteSchema.index({ code: 1, direction: 1 }, { sparse: true });
