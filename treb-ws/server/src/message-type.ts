
/**
 * this message is a reflected command-log message from
 * one of the instances. can be any instance. this message
 * will be sent from instance X to instances Y, Z, A, &c.
 * 
 * there's one additional case when a client connects, if 
 * messages arrive and the client is not in a CONNECTED state, 
 * messages will be queued until the state changes.
 * 
 * client -> server -> (other) clients
 * 
 * the message should not be sent back to the originator.
 */
export interface CommandLogMessage {
  type: 'command-log';
  data: any; // this is a TREB type
}

/**
 * this message is sent by the server to a client to tell
 * the client it is now the leader. that client will be the
 * leader until it disconnects.
 * 
 * server -> client
 */
export interface LeaderAssignmentMessage {
  type: 'leader-assignment';
  leader: boolean; // indicates to recipient, "you are the leader".
}

/**
 * this message is sent by the leader after a calculation; 
 * it includes all calculation data from the model.
 * 
 * client -> server -> (other) clients
 * 
 * like the command-log message, this message is generated by
 * one client (the leader) and distributed to all other clients.
 */
export interface CalculationDataMessage {
  type: 'calculation-data';
  data: any; // this is a TREB type
}

/**
 * this message is sent by a follower client when it wants to 
 * recalculate. since calculation is centralized, we send a 
 * request to the leader; the leader performs the calculation
 * and the standard semantics should trigger a calculation-data 
 * message.
 * 
 * follower -> server -> leader
 * 
 */
export interface RequestRecalcMessage {
  type: 'request-recalculation';
}

/**
 * this message is used to request the full model from the leader.
 * when a client connects, and there is a leader, the server will
 * ask the leader for the full model. the leader responds with the 
 * data; the server forwards that to the new client.
 * 
 * server -> leader -> new client
 * 
 * the server does not maintain a TREB instance (perhaps it should)
 * so it can't handle deltas from command-log and calulation-data 
 * messages. as a result when a new client connects we need the 
 * leader to give us the canonical version of the document. 
 */
export interface FullModelMessage {
  type: 'full-model';

  /** this is a request, from the server */
  request?: boolean;

  /** this is a response, from the leader */
  response?: boolean;

}

/**
 * the generic type is a discriminated union.
 */
export type Message
  = CommandLogMessage 
  | LeaderAssignmentMessage
  | CalculationDataMessage
  | RequestRecalcMessage
  | FullModelMessage
  ;

  