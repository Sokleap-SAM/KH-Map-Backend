import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
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
}

export const BusSchema = SchemaFactory.createForClass(Bus);
