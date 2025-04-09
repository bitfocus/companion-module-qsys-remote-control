export const errorCodes = {
	'-32700': 'Parse error. Invalid JSON was received by the server.',
	'-32600': 'Invalid request. The JSON sent is not a valid Request object.',
	'-32601': 'Method not found.',
	'-32602': 'Invalid params.',
	'-32603': 'Server error.',
	'-32604':
		'Core is on Standby. This code is returned when a QRC command is received while the Core is not the active Core in a redundant Core configuration.',
	2: 'Invalid Page Request ID',
	3: 'Bad Page Request - could not create the requested Page Request',
	4: 'Missing file',
	5: 'Change Groups exhausted',
	6: 'Unknown change group',
	7: 'Unknown component name',
	8: 'Unknown control',
	9: 'Illegal mixer channel index',
	10: 'Logon required',
}

export const errorKeys = Object.keys(errorCodes)
