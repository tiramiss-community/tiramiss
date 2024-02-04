import { EventEmitter } from 'eventemitter3';
import { CellValue } from '@/components/grid/cell.js';

export type GridSetting = {
	rowNumberVisible?: boolean;
	rowSelectable?: boolean;
	rowMinimumDefinitionCount?: number;
}

export const defaultGridSetting: Required<GridSetting> = {
	rowNumberVisible: true,
	rowSelectable: true,
	rowMinimumDefinitionCount: 100,
};

export type DataSource = Record<string, CellValue>;

export type GridState =
	'normal' |
	'cellSelecting' |
	'cellEditing' |
	'colResizing' |
	'colSelecting' |
	'rowSelecting' |
	'hidden'
	;

export type Size = {
	width: number;
	height: number;
}

export type SizeStyle = number | 'auto' | undefined;

export class GridEventEmitter extends EventEmitter<{
	'forceRefreshContentSize': void;
}> {
}
