import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ timestamps: true, collection: 'test_odc_stops' })
export class TestOdcStop extends Document {
  // The '!' tells TypeScript that Mongoose will definitely assign this property
  @Prop({ required: true })
  nameKhmer!: string;

  @Prop({
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point',
    },
    coordinates: {
      type: [Number],
      required: true,
    },
  })
  location!: {
    type: string;
    coordinates: number[];
  };

  @Prop({ required: false })
  lineName?: string;
}

export const TestOdcStopSchema = SchemaFactory.createForClass(TestOdcStop);
TestOdcStopSchema.index({ location: '2dsphere' });
