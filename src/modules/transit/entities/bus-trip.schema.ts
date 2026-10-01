import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { BaseEntity } from '../../../shared/database/base.entity';

export type BusTripDocument = HydratedDocument<BusTrip>;

@Schema({ timestamps: true, collection: 'bus_trips' })
export class BusTrip extends BaseEntity {
  @Prop({ required: true, type: Types.ObjectId, ref: 'BusRoute' })
  route!: Types.ObjectId;

  @Prop({ required: true, type: Types.ObjectId, ref: 'Bus' })
  bus!: Types.ObjectId;

  // Driver who actually operated this trip. Stamped on startTrip; stays set
  // even after the trip is completed or cancelled so the driver's trip
  // history survives bus reassignment.
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  driver!: Types.ObjectId | null;

  @Prop({
    required: true,
    type: String,
    enum: ['scheduled', 'in-progress', 'completed', 'cancelled'],
    default: 'scheduled',
  })
  status!: string;

  @Prop({ type: Date, default: null })
  startedAt!: Date | null;

  @Prop({ type: Date, default: null })
  completedAt!: Date | null;
}

export const BusTripSchema = SchemaFactory.createForClass(BusTrip);
BusTripSchema.index({ status: 1 });
BusTripSchema.index({ route: 1, status: 1 });
BusTripSchema.index({ bus: 1, status: 1 });
BusTripSchema.index({ driver: 1, createdAt: -1 });
