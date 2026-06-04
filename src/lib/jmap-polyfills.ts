const objectWithHasOwn = Object as ObjectConstructor & {
  hasOwn?: (object: unknown, property: PropertyKey) => boolean;
};
const objectWithFromEntries = Object as ObjectConstructor & {
  fromEntries?: <T = unknown>(entries: Iterable<readonly [PropertyKey, T]>) => Record<PropertyKey, T>;
};
const mapWithGroupBy = Map as MapConstructor & {
  groupBy?: <T, K>(items: Iterable<T>, callback: (item: T, index: number) => K) => Map<K, T[]>;
};

objectWithHasOwn.hasOwn ??= (object: unknown, property: PropertyKey) =>
  Object.prototype.hasOwnProperty.call(Object(object), property);

objectWithFromEntries.fromEntries ??= <T = unknown>(
  entries: Iterable<readonly [PropertyKey, T]>,
) => {
  const object: Record<PropertyKey, T> = {};

  for (const [key, value] of entries) {
    object[key] = value;
  }

  return object;
};

mapWithGroupBy.groupBy ??= <T, K>(
  items: Iterable<T>,
  callback: (item: T, index: number) => K,
) => {
  const grouped = new Map<K, T[]>();
  let index = 0;

  for (const item of items) {
    const key = callback(item, index);
    const values = grouped.get(key);

    if (values) {
      values.push(item);
    } else {
      grouped.set(key, [item]);
    }

    index += 1;
  }

  return grouped;
};
