import { Schema } from '@nestjs/mongoose';
import { Types } from 'mongoose';

@Schema({ timestamps: true })
export class BaseEntity {
  _id: Types.ObjectId;

  createdAt: Date;

  updatedAt: Date;
}
