/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsNumber,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  Max,
} from 'class-validator';

export enum RouteType {
  WALK = 'walk',
  TRANSIT = 'transit',
}

export enum Language {
  ENGLISH = 'english',
  KHMER = 'khmer',
}

export class PlanRouteDto {
  @Transform(({ value }) => parseFloat(value))
  @IsNumber()
  @IsNotEmpty()
  @Min(-180)
  @Max(180)
  originLng!: number;

  @Transform(({ value }) => parseFloat(value))
  @IsNumber()
  @IsNotEmpty()
  @Min(-90)
  @Max(90)
  originLat!: number;

  @Transform(({ value }) => parseFloat(value))
  @IsNumber()
  @IsNotEmpty()
  @Min(-180)
  @Max(180)
  destLng!: number;

  @Transform(({ value }) => parseFloat(value))
  @IsNumber()
  @IsNotEmpty()
  @Min(-90)
  @Max(90)
  destLat!: number;

  @IsOptional()
  @IsEnum(RouteType)
  type?: RouteType = RouteType.TRANSIT;

  /**
   * Language for all human-readable text in the response — stop names and the
   * fixed labels ("Your Location", "Destination", "Walking", warnings).
   * `khmer` → stop `nameInKhmer`; `english` → stop `nameInLatin`. Defaults to
   * `khmer` to preserve the previous (Khmer-only) behaviour for old clients.
   * Route `name`/`code` are returned as stored — the route schema has no
   * per-language variant.
   */
  @IsOptional()
  @IsEnum(Language)
  language?: Language = Language.KHMER;

  /**
   * Optional ranking bias for triggered (mid-trip) re-plans: a comma-separated
   * list of route ids the user is already committed to (e.g. `preferRouteIds=r1,r2`).
   * Options whose bus legs use these routes get a ranking bonus so an off-route
   * re-plan keeps the user on their journey where reasonable, instead of
   * snapping to a different "fastest". Purely a tie-breaker nudge — it never
   * resurrects an option the solver didn't already find. Omit for normal plans.
   * The transform splits the CSV and drops blanks; an already-array value
   * (repeated query param) is passed through.
   */
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((v: string) => v.trim())
          .filter((v: string) => v.length > 0)
      : value,
  )
  @IsArray()
  @IsString({ each: true })
  preferRouteIds?: string[];
}
