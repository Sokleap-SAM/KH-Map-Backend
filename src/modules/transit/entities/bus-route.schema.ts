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

  @Prop({
    required: true,
    type: String,
    enum: ['active', 'inactive'],
    default: 'active',
  })
  status!: string;
}

export const BusRouteSchema = SchemaFactory.createForClass(BusRoute);
BusRouteSchema.index({ isLine: 1 });
BusRouteSchema.index({ code: 1 }, { sparse: true });
