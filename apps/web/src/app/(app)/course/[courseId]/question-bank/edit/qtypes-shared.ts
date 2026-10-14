// Shared by the answer editors of the question types.

export type Data = Record<string, unknown>;

export interface FieldsProps {
  data: Data;
  setData: (d: Data) => void;
}

let seq = 0;
export const nid = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Helpers for the lists in a question's data (answers, pairs). */
export function listHelpers({ data, setData }: FieldsProps) {
  const list = <T>(key: string) => (data[key] as T[]) ?? [];
  return {
    list,
    setItem: (key: string, i: number, patch: Data) =>
      setData({
        ...data,
        [key]: list<Data>(key).map((x, j) => (j === i ? { ...x, ...patch } : x)),
      }),
    removeItem: (key: string, i: number) =>
      setData({ ...data, [key]: list<Data>(key).filter((_, j) => j !== i) }),
  };
}
