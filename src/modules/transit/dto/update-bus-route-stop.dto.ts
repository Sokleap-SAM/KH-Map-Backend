import { PartialType } from '@nestjs/mapped-types';
import { CreateBusRouteStopDto } from './create-bus-route-stop.dto';

export class UpdateBusRouteStopDto extends PartialType(CreateBusRouteStopDto) {}
