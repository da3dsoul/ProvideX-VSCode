import { toPxts } from '../server/src/pxts/toPxts';
import { fromPxts } from '../server/src/pxts/fromPxts';
const pvx = ['IF A THEN {', 'X=1', '} ELSE LET CHANGE_FLG=0', 'Y=2'].join('\n');
const ts = toPxts(pvx).text;
console.log(ts);
console.log('----');
console.log(fromPxts(ts).text);
