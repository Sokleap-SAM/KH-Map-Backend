import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { BaseEntity } from '../../../shared/database/base.entity';

export type BusDocument = HydratedDocument<Bus>;

@Schema({ timestamps: true, collection: 'buses' })
export class Bus extends BaseEntity {
  @Prop({ required: true, unique: true, type: String })
  busNumber?: string;

  @Prop({ required: true, unique: true, type: String })
  licensePlate?: string;

  @Prop({ required: true, type: Number })
  capacity?: number;

  @Prop({
    required: true,
    type: String,
    enum: ['in-service', 'out-of-service', 'maintenance'],
    default: 'in-service',
  })
  status?: string;

  // Denormalized pointer back to the driver assigned to this bus. Kept in sync
  // with User.assignedBusId by the admin assignment endpoint so trip-start
  // checks ("is this driver allowed to operate this bus?") run without an
  // extra users-collection lookup.
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  assignedDriverId?: Types.ObjectId | null;
}

export const BusSchema = SchemaFactory.createForClass(Bus);
