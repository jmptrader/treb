
/**
 * this is the data side of autocomplete (maintaining the list, matching).
 * we add this to grid because grid controls the editors; clients can pass
 * in lists.
 *
 * TODO: structure
 * TODO: other symbols...
 */

export interface ArgumentDescriptor {
  name?: string;
}

export interface FunctionDescriptor {
  name: string;
  arguments?: ArgumentDescriptor[];
}

export interface AutocompleteMatchData {
  text: string;
  cursor: number;
}

export class AutocompleteMatcher {

  private function_names: string[] = [];
  private function_map: {[index: string]: FunctionDescriptor} = {};

  public SetFunctions(functions: FunctionDescriptor[]) {
    this.function_map = {};
    this.function_names = functions.map((fn) => {
      this.function_map[fn.name.toLowerCase()] = fn;
      return fn.name;
    }).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  }

  public Exec(data: AutocompleteMatchData) {

    // ac/tt only for formula
    if (data.text[0] !== '=') return {};

    let match;
    let result: any = {};

    // ac only at the end of the string
    if (data.cursor === data.text.length) {

      // FIXME: quoted strings...

      // if it's a token, and ends with a legal character
      match = data.text.match(/(?:^|[^A-Za-z_])([A-Za-z_][\w\d_\.]*)\s*$/);
      if (match) {
        const token = match[1];
        const rex = new RegExp('^' + token.replace('.', '\\.'), 'i');
        const list = this.function_names.filter((name) => rex.test(name));
        result = {
          completions: list, token, position: data.cursor - token.length,
        };
      }

    }

    // check for tt: we're in a function call
    // let's do a baby parser

    let sub = data.text.substr(0, data.cursor);
    const closed_function = /(?:^|[^A-Za-z_])([A-Za-z_][\w\d_\.]*\s*\([^\(\)]*\))/;
    const open_function = /([A-Za-z_][\w\d_\.]*)\s*\(/g;

    match = sub.match(closed_function);
    while (match) {
      sub = sub.substr(0, (match.index || 0) + 1) + sub.substr((match.index || 0) + 1 + match[1].length);
      match = sub.match(closed_function);
    }

    let tt = '';
    match = open_function.exec(sub);
    while (match) {
      tt = match[1];
      match = open_function.exec(sub);
    }

    if (tt) {
      const func = this.function_map[tt.toLowerCase()];
      if (func) {
        // if (func.canonical_name) result.tooltip = func.canonical_name;
        // else result.tooltip = tt.toUpperCase();
        result.tooltip = func.name;
        result.arguments = '(' + (func.arguments || []).map((desc) => (desc.name || 'argument')).join(', ') + ')';
      }
    }

    return result;
  }

}
