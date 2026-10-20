// The fixture portfolio (README.md), in the order of design reference §18.4.
import { dynamicCalls } from './dynamic-calls.ts';
import { featureFlow } from './feature-flow.ts';
import type { Fixture } from './fixture.ts';
import { independentRoots } from './independent-roots.ts';
import { interfaceImpl } from './interface-impl.ts';
import { largeGenerated } from './large-generated.ts';
import { overrideDispatch, overrideDispatchPython } from './override-dispatch.ts';
import { removedCalls } from './removed-calls.ts';
import { renameMove } from './rename-move.ts';
import { sameName } from './same-name.ts';
import { signature } from './signature.ts';
import { tenCallers } from './ten-callers.ts';
import { testsAndConfig } from './tests-and-config.ts';
import { unchangedCaller } from './unchanged-caller.ts';
import { unsupportedBinary } from './unsupported-binary.ts';

export const FIXTURES: readonly Fixture[] = [
  signature,
  tenCallers,
  unchangedCaller,
  removedCalls,
  renameMove,
  independentRoots,
  featureFlow,
  interfaceImpl,
  overrideDispatch,
  overrideDispatchPython,
  sameName,
  testsAndConfig,
  dynamicCalls,
  unsupportedBinary,
  largeGenerated,
];
