/**
 * 输入法（IME）合成安全的 AntD 文本输入组件。
 *
 * 依据版本：antd 5.29.3 / rc-input 1.8.0 / rc-textarea / rc-select 14.16.8 / React 18.3.1。
 *
 * 问题背景：
 * - React 18 在原生 input 事件上派发 onChange，不内置 IME 合成判断；合成期间
 *   每敲一个拼音字母、手写每一笔识别，都会触发 onChange 把「中间态」写进受控 value。
 * - rc-input 1.8.0 在 compositionend 时会以 `source: 'compositionEnd'` 主动跳过
 *   onChange（ant-design #46587），所以最终文本需要补发一次。
 *
 * 因此只在 compositionend 补发 onChange 并不够（中间态早已污染表单）。正确做法：
 * 1. compositionstart 标记合成中；
 * 2. 合成期间 onChange 只更新本地显示值，不提交给业务（并用 nativeEvent.isComposing
 *    兜底，覆盖事件顺序差异）；
 * 3. compositionend 清标记、用最终 DOM 值更新显示并补发一次业务 onChange；
 * 4. 外部 value 变化（回填 / 重置）时同步本地显示值，但合成期间跳过以免打断输入。
 */
import React, { useEffect, useRef, useState } from 'react';
import { Input } from 'antd';
import type { InputProps, InputRef } from 'antd';
import type { PasswordProps } from 'antd/es/input/Password';
import type { TextAreaProps, TextAreaRef } from 'antd/es/input/TextArea';

type TextInputElement = HTMLInputElement | HTMLTextAreaElement;
export type ImeTextValue = InputProps['value'];

export function imeDisplayString(value: ImeTextValue): string {
  return value === undefined || value === null ? '' : String(value);
}

/** 合成期间维护「显示值」的控制器：中间态只显示、不提交业务。 */
export interface ImeDisplayController {
  readonly composingRef: React.MutableRefObject<boolean>;
  readonly displayValue: string;
  readonly setDisplayValue: React.Dispatch<React.SetStateAction<string>>;
  readonly startComposition: () => void;
  readonly endComposition: () => void;
}

export function useImeDisplay(externalValue: ImeTextValue): ImeDisplayController {
  const composingRef = useRef<boolean>(false);
  const [displayValue, setDisplayValue] = useState<string>(() => imeDisplayString(externalValue));
  const previousExternal = useRef<ImeTextValue>(externalValue);

  // 外部 value 变化（Form reset / setFieldsValue / 编辑回填）时同步；合成期间不覆盖。
  useEffect((): void => {
    if (externalValue === previousExternal.current) {
      return;
    }
    previousExternal.current = externalValue;
    if (!composingRef.current) {
      setDisplayValue(imeDisplayString(externalValue));
    }
  }, [externalValue]);

  return {
    composingRef,
    displayValue,
    setDisplayValue,
    startComposition: (): void => {
      composingRef.current = true;
    },
    endComposition: (): void => {
      composingRef.current = false;
    },
  };
}

interface ImeTextProps<T extends TextInputElement> {
  readonly value?: ImeTextValue;
  readonly onChange?: React.ChangeEventHandler<T>;
  readonly onCompositionStart?: React.CompositionEventHandler<T>;
  readonly onCompositionEnd?: React.CompositionEventHandler<T>;
}

interface ImeHandlers<T extends TextInputElement> {
  readonly value: string;
  readonly onChange: React.ChangeEventHandler<T>;
  readonly onCompositionStart: React.CompositionEventHandler<T>;
  readonly onCompositionEnd: React.CompositionEventHandler<T>;
}

function useImeValue<T extends TextInputElement>(props: ImeTextProps<T>): ImeHandlers<T> {
  const { value: externalValue, onChange, onCompositionStart, onCompositionEnd } = props;
  const ime = useImeDisplay(externalValue);

  const handleCompositionStart = (event: React.CompositionEvent<T>): void => {
    ime.startComposition();
    onCompositionStart?.(event);
  };

  const handleChange = (event: React.ChangeEvent<T>): void => {
    const nextValue: string = event.target.value;
    ime.setDisplayValue(nextValue);
    // 合成中间态只用于显示，绝不写进表单：否则 React 会把拼音字母回写 DOM，
    // 打断输入法组合，表现为候选框一闪即消失、只剩字母。
    const isComposing: boolean =
      ime.composingRef.current || (event.nativeEvent as InputEvent).isComposing === true;
    if (isComposing) {
      return;
    }
    onChange?.(event);
  };

  const handleCompositionEnd = (event: React.CompositionEvent<T>): void => {
    ime.endComposition();
    const finalValue: string = event.currentTarget.value;
    ime.setDisplayValue(finalValue);
    // rc-input / rc-textarea 在 compositionend 跳过 onChange，这里补发最终文本。
    // CompositionEvent 与 ChangeEvent 的 target 同为当前输入元素，业务 handler 只读
    // target.value，因此可安全复用该事件对象。
    onChange?.(event as unknown as React.ChangeEvent<T>);
    onCompositionEnd?.(event);
  };

  return {
    value: ime.displayValue,
    onChange: handleChange,
    onCompositionStart: handleCompositionStart,
    onCompositionEnd: handleCompositionEnd,
  };
}

const ImeBaseInput = React.forwardRef<InputRef, InputProps>((props, ref) => {
  const handlers = useImeValue<HTMLInputElement>(props);
  return <Input {...props} {...handlers} ref={ref} />;
});
ImeBaseInput.displayName = 'ImeInput';

const ImePasswordInput = React.forwardRef<InputRef, PasswordProps>((props, ref) => {
  const handlers = useImeValue<HTMLInputElement>(props);
  return <Input.Password {...props} {...handlers} ref={ref} />;
});
ImePasswordInput.displayName = 'ImePasswordInput';

const ImeTextArea = React.forwardRef<TextAreaRef, TextAreaProps>((props, ref) => {
  const handlers = useImeValue<HTMLTextAreaElement>(props);
  return <Input.TextArea {...props} {...handlers} ref={ref} />;
});
ImeTextArea.displayName = 'ImeTextArea';

export const ImeInput = Object.assign(ImeBaseInput, {
  Password: ImePasswordInput,
  TextArea: ImeTextArea,
});

export default ImeInput;
