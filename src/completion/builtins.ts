export const PICORUBY_BUILTIN_CLASSES = [
	'Array',
	'Hash',
	'String',
	'Integer',
	'Float',
	'Symbol',
	'Range',
	'Time',
	'Object',
	'Proc',
	'Task',
	'GPIO',
	'UART',
	'I2C',
	'SPI',
	'ADC',
	'PWM'
] as const;

export const PICORUBY_BUILTIN_METHODS = [
	'puts',
	'print',
	'p',
	'require',
	'load',
	'loop',
	'sleep',
	'raise',
	'attr_reader',
	'attr_writer',
	'attr_accessor',
	'new',
	'initialize',
	'call',
	'each',
	'map',
	'select',
	'length',
	'size',
	'to_s',
	'to_i',
	'pin_mode',
	'digital_write',
	'digital_read',
	'analog_read',
	'pwm_write'
] as const;

export const PICORUBY_BUILTIN_CONSTANTS = [
	'TRUE',
	'FALSE',
	'NIL'
] as const;

export const PICORUBY_MODULE_FUNCTIONS = [
	'require',
	'load',
	'sleep',
	'pin_mode',
	'digital_write',
	'digital_read',
	'analog_read',
	'pwm_write'
] as const;
