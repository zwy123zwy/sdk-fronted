/**
 * C01-F4 类型化事件：用事件字典约束 `track` 的事件名与字段。
 *
 * ## 字典形状（**给 T22/K01 生成物的接口契约**）
 *
 * K01（T22）应生成满足下面形状的类型包；字段按**描述**声明，而不是只给字段名列表，
 * 这样 `track` 的字段级校验才能表达 `enum` 字面量联合、`boolean` 与必填/可选：
 *
 * ```ts
 * type FieldSpec<TValue, TRequired extends boolean> = {
 *   readonly type: TValue;
 *   readonly required: TRequired;                   // 字面量布尔，不是可选属性
 * };
 * type EventDefinitionShape = {
 *   readonly priority: 'normal' | 'critical';       // Q3：事件优先级（字面量）
 *   readonly schema_version: number;                // 字面量；缺省 1
 *   readonly dimensions: {
 *     readonly task_id: FieldSpec<string, true>;          // 必填：属性不可选 + required: true
 *     readonly channel?: FieldSpec<'web' | 'app', false>; // 可选：属性带 ? + required: false
 *   };
 *   readonly metrics: Readonly<Record<string, FieldSpec<number, boolean>>>;
 * };
 * ```
 *
 * - 维度 `type` 取 `string`、`boolean`（由 C04 序列化为 `"true"`/`"false"`）或字面量联合
 *   （`enum`：`'web' | 'app'`）；指标 `type` 取 `number`。
 * - K01 生成物用「属性是否带 `?`」+ `required` 字面量成对表达必填/可选：
 *   `task_id: FieldSpec<string, true>` / `channel?: FieldSpec<string, false>`。
 * - **判断必填必须用属性可选性投影，不要索引 `required`**：在 `noUncheckedIndexedAccess`
 *   下索引可选属性会带上 `| undefined`，判断失真并把字段类型推成 `never`。
 * - `defineEventDictionary` 的 `const` 类型参数保证字段字面量不被宽化；
 *   K01 生成的 `.d.ts` 直接写类型即可。
 *
 * ## 校验效果（C01-AC-09）
 *
 * - 未登记的事件名：`tsc` 报错；
 * - 缺少 `required: true` 的字段：`tsc` 报错；
 * - 字段类型错误、`enum` 值不在联合内：`tsc` 报错；
 * - 多出未声明字段：`tsc` 报错；
 * - 未传字典（`createClient()`）时事件名放宽为 `string`，由运行时按命名规则校验。
 *
 * ## 实现说明（踩过的坑，改动前先读）
 *
 * 1. `track` 必须是「事件名依赖参数类型」的泛型签名：`track<TName>(name, input?: EventRequestOf<D, TName>)`。
 *    若把参数类型替换成已求值/延迟求值的类型（如 `Parameters<TrackMap<D>[N]>[0]`），
 *    TypeScript 会静默接受缺字段与多余字段。
 * 2. 条件类型里的字段属性是**可选**的（`readonly dimensions?: ...`），必须写成可选形式，
 *    否则 `undefined` 会让推断失败并退化成 `never`（字段级校验全部失效）。
 */

/**
 * K01（T22）生成物的字段描述。`required` 是**字面量布尔**（`true` / `false`）。
 * 生成物用「属性是否带 `?`」表达字段可选性，两者成对出现：
 * `required_field: FieldSpec<..., true>` / `optional_field?: FieldSpec<..., false>`。
 */
export interface FieldSpec<TValue, TRequired extends boolean = boolean> {
  /** 字段的类型：维度用 `string` / `boolean` / 字面量联合；指标用 `number`。 */
  readonly type: TValue;
  /** 是否必填。 */
  readonly required: TRequired;
}

/**
 * 便利写法的宽松字段描述：`required` 可省略（省略按可选字段处理）。
 * 手写字典用；K01 生成物用上面的 `FieldSpec`，两者结构兼容。
 */
export interface LooseFieldSpec<TValue> {
  readonly type: TValue;
  readonly required?: boolean | undefined;
}

/** 事件定义（K01 生成物的形状）。 */
export interface EventDefinitionShape {
  /** 事件优先级；缺省 `normal`（Q3）。 */
  readonly priority?: 'normal' | 'critical' | undefined;
  /** 事件定义的版本；缺省 `1`。 */
  readonly schema_version?: number | undefined;
  /** 维度字段描述。 */
  readonly dimensions?: Readonly<Record<string, LooseFieldSpec<unknown>>> | undefined;
  /** 指标字段描述。 */
  readonly metrics?: Readonly<Record<string, LooseFieldSpec<unknown>>> | undefined;
}

/** 事件字典：事件名 → 定义。普通对象字面量即可满足。 */
export type EventDictionary = Readonly<Record<string, EventDefinitionShape>>;

/**
 * 校验并保留字典字面量类型：不满足 `EventDictionary` 形状时报错。
 * `const` 类型参数保证字面量（含 `boolean`、字面量联合）不被宽化。
 */
export function defineEventDictionary<const TDictionary extends EventDictionary>(
  dictionary: TDictionary,
): TDictionary {
  return dictionary;
}

/**
 * 未传字典时的宽松字典：事件名放宽为 `string`，维度值放宽为字符串/布尔，指标为数字。
 * 用于 `createClient()` 不带类型参数的场景，保证 `track('any_name', {...})` 可用。
 */
export type PermissiveDictionary = {
  readonly [eventName: string]: {
    readonly priority?: 'normal' | 'critical' | undefined;
    readonly schema_version?: number | undefined;
    readonly dimensions?: Readonly<Record<string, LooseFieldSpec<string | boolean>>> | undefined;
    readonly metrics?: Readonly<Record<string, LooseFieldSpec<number>>> | undefined;
  };
};

/** 取定义的维度字段描述表。 */
export type DimensionFieldsOf<TDefinition> = NonNullable<TDefinition> extends {
  readonly dimensions?: infer TFields | undefined;
}
  ? TFields
  : never;

/** 取定义的指标字段描述表。 */
export type MetricFieldsOf<TDefinition> = NonNullable<TDefinition> extends {
  readonly metrics?: infer TFields | undefined;
}
  ? TFields
  : never;

/** 取字段描述里的值类型。 */
export type FieldValue<TField> = TField extends { readonly type: infer TValue } ? TValue : never;

/**
 * 字段描述表里属性**带 `?`** 的键（K01 生成物用属性可选性表达可选字段）。
 *
 * 注意：不要用 `TFields[K]['required'] extends true` 判断必填——在 `noUncheckedIndexedAccess`
 * 下，可选属性被索引时会带上 `| undefined`，判断失真并把负载字段类型推成 `never`。
 * 这里先用属性类型投影（`undefined extends T[K]`，即该属性是否可选），
 * 再用 `NonNullable<T[K]>` 读 `required` 字面量（绕开该坑），
 * 兼顾 K01 生成物（`?` 标记）与手写便利字典（`required: false`）两种形态。
 */
export type QuestionMarkFieldKeys<TFields> = {
  [K in keyof TFields]-?: undefined extends TFields[K] ? K : never;
}[keyof TFields];

/** 字段描述表里 `required` 字面量为 `true` 的键。 */
export type FlaggedRequiredFieldKeys<TFields> = {
  [K in keyof TFields]-?: NonNullable<TFields[K]> extends { readonly required: true } ? K : never;
}[keyof TFields];

/** 必填字段键：属性不可选，且未被标记为可选。 */
export type RequiredFieldKeys<TFields> = Exclude<
  FlaggedRequiredFieldKeys<TFields>,
  QuestionMarkFieldKeys<TFields>
>;

/** 非必填字段键。 */
export type OptionalFieldKeys<TFields> = Exclude<keyof TFields, RequiredFieldKeys<TFields>>;

/** 必填字段部分。 */
export type RequiredShape<TFields> = {
  readonly [K in RequiredFieldKeys<TFields>]: FieldValue<TFields[K]>;
};

/** 可选字段部分。 */
export type OptionalShape<TFields> = {
  readonly [K in OptionalFieldKeys<TFields>]?: FieldValue<TFields[K]>;
};

/**
 * 由字段描述表生成入参对象类型：`required: true` 的键是必需属性，其余是可选属性。
 * 带索引签名的表（`PermissiveDictionary`）退化为任意字符串键。
 */
export type ShapeOf<TFields> = [TFields] extends [never]
  ? object
  : string extends keyof TFields
    ? { readonly [key: string]: FieldValue<TFields[keyof TFields]> }
    : RequiredShape<TFields> & OptionalShape<TFields>;

/** 事件维度对象类型。 */
export type DimensionFields<TDefinition> = ShapeOf<DimensionFieldsOf<TDefinition>>;

/** 事件指标对象类型。 */
export type MetricFields<TDefinition> = ShapeOf<MetricFieldsOf<TDefinition>>;

/** 某个事件在 `track` 中接受的参数类型。 */
export interface EventRequest<TDefinition> {
  readonly dimensions?: DimensionFields<TDefinition> | undefined;
  readonly metrics?: MetricFields<TDefinition> | undefined;
  /** 附加文本（日志、错误栈）；长度约束由 C04 处理。 */
  readonly attachment?: string | undefined;
  /** 覆盖事件优先级；缺省取定义里的 `priority`，再缺省 `normal`。 */
  readonly priority?: 'normal' | 'critical' | undefined;
}

/** 取出 `track` 在给定事件名下的入参类型。 */
export type EventRequestOf<
  TDictionary extends EventDictionary,
  TName extends keyof TDictionary & string,
> = EventRequest<TDictionary[TName]>;
