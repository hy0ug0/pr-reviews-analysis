// True only when A and B are the same type, including optional fields that zod would
// otherwise strip on read. Used as `true satisfies Equals<z.infer<typeof schema>, Type>`.
export type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
