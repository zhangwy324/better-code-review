// The few LSP types the client reads. Positions are 0-based, `character` in UTF-16 code units.

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  uri: string;
  range: Range;
}

export interface LocationLink {
  targetUri: string;
  targetRange: Range;
  targetSelectionRange: Range;
}

export interface Diagnostic {
  range: Range;
  message: string;
  code?: string | number;
  severity?: number;
  source?: string;
}

export interface CallHierarchyItem {
  name: string;
  uri: string;
  range: Range;
  selectionRange: Range;
}

export interface CallHierarchyIncomingCall {
  from: CallHierarchyItem;
  fromRanges: Range[];
}
