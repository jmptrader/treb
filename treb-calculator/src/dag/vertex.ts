
/**
 * colors for the CLRS color algorithm. 
 * 
 * these colors are useful because gray is "in between" white and black, but
 * (outside of the general move away from using white/black as identifiers) it 
 * might be easier to conceptualize with descriptive labels like "untested" 
 * (white), "being tested", (gray) and "testing complete" (black).
 */
export enum Color {
  white, gray, black
}

export class Vertex {

  /** 
   * vertex and its subclasses have a type parameter for type 
   * guards/reflection; each instance has a type that is set
   * to the static class type.
   */
  public static type = 'vertex';

  // --- members ---

  public type = Vertex.type; // for type guard

  public color = Color.white; // for loop check

  /** dependencies */
  public edges_in: Vertex[] = [];

  /** dependents */
  public edges_out: Vertex[] = [];

  // --- accessors ---

  get has_inbound_edges(): boolean { return this.edges_in.length > 0; }

  get has_outbound_edges(): boolean { return this.edges_out.length > 0; }

  // --- cleanup operations ---

  /** reset this node */
  public Reset(): void {

    for (const edge of this.edges_out) {
      edge.RemoveDependency(this);
    }

    for (const edge of this.edges_in) {
      edge.RemoveDependent(this);
    }

    this.edges_out = [];
    this.edges_in = [];

  }

  /** removes all inbound edges (dependencies) */
  public ClearDependencies(): void {
    for (const edge of this.edges_in) {
      edge.RemoveDependent(this);
    }
    this.edges_in = [];
  }

  // --- basic node operations ---

  /** add a dependent. doesn't add if already in the list */
  public AddDependent(edge: Vertex): void {
    if (edge === this) return; // circular
    for (const check of this.edges_out) {
      if (check === edge) {
        return;
      }
    }
    this.edges_out.push(edge);
  }

  /** remove a dependent */
  public RemoveDependent(edge: Vertex): void {
    this.edges_out = this.edges_out.filter((check) => check !== edge);
  }

  /** add a dependency. doesn't add if already in the list */
  public AddDependency(edge: Vertex): void {
    if (edge === this) return; // circular
    for (const check of this.edges_in) {
      if (check === edge) {
        return;
      }
    }

    this.edges_in.push(edge);
  }

  /** remove a dependency */
  public RemoveDependency(edge: Vertex): void {
    this.edges_in = this.edges_in.filter((check) => check !== edge);
  }

  /** 
   * this is a composite operation, because the operations are always called 
   * in pairs. this means create a pair of links such that _edge_ depends on
   * _this_.
   */
  public LinkTo(edge: Vertex): void {
    this.AddDependent(edge);
    edge.AddDependency(this);
  }

  /**
   * this is an alteranate formulation that may make more intuitive sense.
   * it creates a pair of forward/backward links, such that _this_ depends
   * on _edge_.
   */
  public DependsOn(edge: Vertex): void {
    this.AddDependency(edge);
    edge.AddDependent(this);
  }

  /**
   * this is called during calculation (if necessary). on a hit (loop), we 
   * reset the color of this, the test node, to white. there are two reasons 
   * for this: 
   * 
   * one, we want subsequent tests to also find the hit. in some cases we may
   * not be marking the node as a loop (if it precedes the backref in the graph),
   * so we want subsequent nodes to also hit the loop. [Q: this makes no sense,
   * because this would still hit if the node were marked grey, assuming you
   * test for that].
   * 
   * two, if you fix the loop, on a subsequent call we want to force a re-check,
   * which we can do if the vertex is marked white. [Q: could also be done on
   * gray?]
   * 
   * [A: logically you are correct, but this works, and matching grey does not].
   */
  public LoopCheck(): boolean {
    this.color = Color.gray;

    const stack: Vertex[] = [this];
    while (stack.length) {

      const u = stack.pop();
      let complete = true;

      for (const v of (u as Vertex).edges_out) {
        if (v.color === Color.white) {
          v.color = Color.gray;
          stack.push(v);
          complete = false;
        }
        else if (v.color === Color.gray) {
          // console.info("found loop", this, v);
          this.color = Color.white; // someone else can test
          return true; // loop
        }
      }

      if (complete) {
        (u as Vertex).color = Color.black;
      }

    }

    /*
    for (const edge of this.edges_out) {
      if (edge.color === Color.gray || (edge.color === Color.white && edge.LoopCheck())) { 
        this.color = Color.white; // someone else can test
        return true; // loop
      } 
    }
    */

    this.color = Color.black;
    return false;
  }

  /*
  public LoopCheck2(compare: Vertex = this): boolean {
    this.color = Color.gray;

    for (const edge of this.edges_out) {
      if (edge.color === Color.gray || (edge.color === Color.white && edge.LoopCheck2(compare))) { 
        this.color = Color.white; // someone else can test
        return edge === compare; // loop
      } 
    }

    this.color = Color.black;
    return false;
    
  }
  */

}


