export interface DailyIntake {
  date: string;
  kcal: number;
  isAtypical: boolean;
}

export function averageOf(values: number[]): number {
  if (values.length === 0) throw new Error('averageOf: empty array');
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function excludeAtypical(intakes: DailyIntake[]): DailyIntake[] {
  return intakes.filter((intake) => !intake.isAtypical);
}

export function fourteenDayAverageKcal(intakes: DailyIntake[]): number {
  return averageOf(excludeAtypical(intakes).map((intake) => intake.kcal));
}

export function sevenDayAverageWeight(weightsKg: number[]): number {
  return averageOf(weightsKg);
}

// Dates are plain YYYY-MM-DD strings, parsed as UTC midnight by `new Date()`.
export function daysSince(fromDate: string, toDate: string): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((new Date(toDate).getTime() - new Date(fromDate).getTime()) / msPerDay);
}
