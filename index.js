var tcp           = require('../../tcp');
var instance_skel = require('../../instance_skel');
var debug;
var log;
var cmd_debug = true;

function instance(system, id, config) {
	var self = this;

	// super-constructor
	instance_skel.apply(this, arguments);

	self.actions(); // export actions
	self.init_presets();

	return self;
}

instance.prototype.updateConfig = function(config) {
	var self = this;
	self.init_presets();

	if (self.socket !== undefined) {
		self.socket.destroy();
		delete self.socket;
	}

	self.config = config;
	self.init_tcp();
};

instance.prototype.init = function() {
	var self = this;

	debug = self.debug;
	log = self.log;
	self.init_presets();
	self.init_tcp();
};

instance.prototype.init_tcp = function() {
	var self = this;

	if (self.socket !== undefined) {
		self.socket.destroy();
		delete self.socket;
	}

	self.status(self.STATE_WARNING, 'Connecting');

	if (self.config.host) {
		self.socket = new tcp(self.config.host, self.config.port);

		self.socket.on('status_change', function (status, message) {
			self.status(status, message);
		});

		self.socket.on('error', function (err) {
			debug("Network error", err);
			self.status(self.STATE_ERROR, err);
			self.log('error',"Network error: " + err.message);
		});

		self.socket.on('connect', function (socket) {
			self.status(self.STATE_OK);
			debug("Connected");

			let login = '{ "jsonrpc":"2.0", "method":"Logon", "params": { "User":"' + self.config.user + '", "Password":"' + self.config.user + '" } }' + '\r';

			if (cmd_debug == true) { console.log('Q-SYS Connected'); }
			if (cmd_debug == true) { console.log('Q-SYS Send: ' + login); }

			self.socket.write(login);

			socket.once('close', function() {
				if (cmd_debug == true) { console.log('Q-SYS Disconnect'); }
			})
		})

		self.socket.on('data', function (d) {
/*
			if (cmd_debug == true) { console.log('Recived: %s', d); }

			if (String(d) == 'Login:\r') {
				self.socket.write(self.config.user + '\r');
				if (cmd_debug == true) { console.log('Response: ' + self.config.user); }
			}
			if (String(d) == 'Password:\r') {
				self.socket.write(self.config.pass + '\r');
				if (cmd_debug == true) { console.log('Response: ' + self.config.pass); }
			}
*/
		})

	}
};


// Return config fields for web config
instance.prototype.config_fields = function () {
	var self = this;

	return [
		{
			type: 'textinput',
			id: 'host',
			label: 'Target IP',
			width: 5,
			regex: self.REGEX_IP
		},
		{
			type: 'textinput',
			id: 'port',
			label: 'Target Port (Default: 1710)',
			width: 3,
			default: 1710,
			regex: self.REGEX_PORT
		},
		{
			type: 'text',
			id: 'info',
			label: 'Information',
			width: 12,
			value: 'Please type in your ID and Password credentials:'
		},
		{
			type: 'textinput',
			id: 'user',
			label: 'ID',
			width: 4,
			default: 'username'
		},
		{
			type: 'textinput',
			id: 'pass',
			label: 'Password',
			width: 4,
			default: '1234'
		}
	]
};

// When module gets deleted
instance.prototype.destroy = function() {
	var self = this;

	if (self.socket !== undefined) {
		self.socket.destroy();
	}

	if (self.udp !== undefined) {
		self.udp.destroy();
	}

	debug("destroy", self.id);
};


instance.prototype.init_presets = function () {
	var self = this;
	var presets = [];
	var pstSize = '18';

	self.setPresetDefinitions(presets);
}

instance.prototype.actions = function(system) {
	var self = this;

	self.system.emit('instance_actions', self.id, {
		'control_set': {
			label: 'Control.set',
			options: [{
				type: 'textinput',
				id: 'name',
				label: 'Name:',
				default: '',
			},
			{
				type: 'textinput',
				id: 'value',
				label: 'Value:',
				default: '',
			}]
		},
		'component_set': {
			label: 'Component.Set',
			options: [{
				type: 'textinput',
				id: 'name',
				label: 'Name:',
				default: '',
			},
			{
				type: 'textinput',
				id: 'control_name',
				label: 'Control Name:',
				default: '',
			},
			{
				type: 'textinput',
				id: 'value',
				label: 'Value:',
				default: '',
			},
			{
				type: 'textinput',
				id: 'ramp',
				label: 'Ramp:',
				default: '',
			}]
		},



		'changeGroup_addControl': {
			label: 'ChangeGroup.AddControl',
			options: [{
				type: 'textinput',
				id: 'id',
				label: 'Group Id:',
				default: '',
			},
			{
				type: 'textinput',
				id: 'controls',
				label: 'Controls:',
				default: '',
			}]
		},
		'changeGroup_addComponentControl': {
			label: 'ChangeGroup.AddComponentControl',
			options: [{
				type: 'textinput',
				id: 'id',
				label: 'Group Id:',
				default: '',
			},
			{
				type: 'textinput',
				id: 'controls',
				label: 'Controls:',
				default: '',
			}]
		},
		'changeGroup_remove': {
			label: 'ChangeGroup.Remove',
			options: [{
				type: 'textinput',
				id: 'id',
				label: 'Group Id:',
				default: '',
			},
			{
				type: 'textinput',
				id: 'controls',
				label: 'Controls:',
				default: '',
			}]
		},
		'changeGroup_destroy': {
			label: 'ChangeGroup.Destroy',
			options: [{
				type: 'textinput',
				id: 'id',
				label: 'Group Id:',
				default: '',
			}]
		},
		'changeGroup_invalidate': {
			label: 'ChangeGroup.Invalidate',
			options: [{
				type: 'textinput',
				id: 'id',
				label: 'Group Id:',
				default: '',
			}]
		},
		'changeGroup_clear': {
			label: 'ChangeGroup.Clear',
			options: [{
				type: 'textinput',
				id: 'id',
				label: 'Group Id:',
				default: '',
			}]
		},



		'mixer_setCrossPointGain': {
			label: 'Mixer.SetCrossPointGain',
			options: [{
				type: 'textinput',
				id: 'name',
				label: 'Name',
				default: '',
			},
			{
				type: 'textinput',
				id: 'input',
				label: 'Input',
				default: '1',
			},
			{
				type: 'textinput',
				id: 'output',
				label: 'Output',
				default: '1',
			},
			{
				type: 'number',
				id: 'value',
				label: 'Value',
				default: 0,
				regex: self.REGEX_NUMBER
			},
			{
				type: 'number',
				id: 'ramp',
				label: 'ramp',
				default: 0,
				regex: self.REGEX_NUMBER
			},
			]
		},
		'mixer_setCrossPointDelay': {
			label: 'Mixer.SetCrossPointDelay',
			options: [{
				type: 'textinput',
				id: 'name',
				label: 'Name',
				default: '',
			},
			{
				type: 'textinput',
				id: 'input',
				label: 'Input',
				default: '1',
			},
			{
				type: 'textinput',
				id: 'output',
				label: 'Output',
				default: '1',
			},
			{
				type: 'number',
				id: 'value',
				label: 'Value',
				default: 0,
				regex: self.REGEX_NUMBER
			},
			{
				type: 'number',
				id: 'ramp',
				label: 'ramp',
				default: 0,
				regex: self.REGEX_NUMBER
			},
			]
		},
		'mixer_setCrossPointMute': {
			label: 'Mixer.SetCrossPointMute',
			options: [{
				type: 'textinput',
				id: 'name',
				label: 'Name',
				default: '',
			},
			{
				type: 'textinput',
				id: 'input',
				label: 'Input',
				default: '1',
			},
			{
				type: 'textinput',
				id: 'output',
				label: 'Output',
				default: '1',
			},
			{
				type: 'dropdown',
				id: 'value',
				label: 'Value',
				default: 'true',
				choices: [
					{ id: 'true', label: 'true' },
					{ id: 'false', label: 'false' },
				]
			},
			]
		},
		'mixer_setCrossPointSolo': {
			label: 'Mixer.SetCrossPointSolo',
			options: [{
				type: 'textinput',
				id: 'name',
				label: 'Name',
				default: '',
			},
			{
				type: 'textinput',
				id: 'input',
				label: 'Input',
				default: '1',
			},
			{
				type: 'textinput',
				id: 'output',
				label: 'Output',
				default: '1',
			},
			{
				type: 'dropdown',
				id: 'value',
				label: 'Value',
				default: 'true',
				choices: [
					{ id: 'true', label: 'true' },
					{ id: 'false', label: 'false' },
				]
			},
			]
		},
		'mixer_setInputGain': {
			label: 'Mixer.SetInputGain',
			options: [{
				type: 'textinput',
				id: 'name',
				label: 'Name',
				default: '',
			},
			{
				type: 'textinput',
				id: 'input',
				label: 'Input',
				default: '1',
			},
			{
				type: 'number',
				id: 'value',
				label: 'Value',
				default: 0,
				regex: self.REGEX_NUMBER
			},
			{
				type: 'number',
				id: 'ramp',
				label: 'ramp',
				default: 0,
				regex: self.REGEX_NUMBER
			},
			]
		},
		'mixer_setInputMute': {
			label: 'Mixer.SetInputMute',
			options: [{
				type: 'textinput',
				id: 'name',
				label: 'Name',
				default: '',
			},
			{
				type: 'textinput',
				id: 'input',
				label: 'Input',
				default: '1',
			},
			{
				type: 'dropdown',
				id: 'value',
				label: 'Value',
				default: 'true',
				choices: [
					{ id: 'true', label: 'true' },
					{ id: 'false', label: 'false' },
				]
			},
			{
				type: 'number',
				id: 'ramp',
				label: 'ramp',
				default: 0,
				regex: self.REGEX_NUMBER
			},
			]
		},
		'mixer_setInputSolo': {
			label: 'Mixer.SetInputSolo',
			options: [{
				type: 'textinput',
				id: 'name',
				label: 'Name',
				default: '',
			},
			{
				type: 'textinput',
				id: 'input',
				label: 'Input',
				default: '1',
			},
			{
				type: 'dropdown',
				id: 'value',
				label: 'Value',
				default: 'true',
				choices: [
					{ id: 'true', label: 'true' },
					{ id: 'false', label: 'false' },
				]
			},
			]
		},
		'mixer_setOutputGain': {
			label: 'Mixer.SetOutputGain',
			options: [{
				type: 'textinput',
				id: 'name',
				label: 'Name',
				default: '',
			},
			{
				type: 'textinput',
				id: 'output',
				label: 'Output',
				default: '1',
			},
			{
				type: 'number',
				id: 'value',
				label: 'Value',
				default: 0,
				regex: self.REGEX_NUMBER
			},
			{
				type: 'number',
				id: 'ramp',
				label: 'ramp',
				default: 0,
				regex: self.REGEX_NUMBER
			},
			]
		},
		'mixer_setOutputMute': {
			label: 'Mixer.SetOutputMute',
			options: [{
				type: 'textinput',
				id: 'name',
				label: 'Name',
				default: '',
			},
			{
				type: 'textinput',
				id: 'output',
				label: 'Output',
				default: '1',
			},
			{
				type: 'dropdown',
				id: 'value',
				label: 'Value',
				default: 'true',
				choices: [
					{ id: 'true', label: 'true' },
					{ id: 'false', label: 'false' },
				]
			},
			]
		},
		'mixer_setCueMute': {
			label: 'Mixer.SetCueMute',
			options: [{
				type: 'textinput',
				id: 'name',
				label: 'Name',
				default: '',
			},
			{
				type: 'textinput',
				id: 'cues',
				label: 'Cues',
				default: '1',
			},
			{
				type: 'dropdown',
				id: 'value',
				label: 'Value',
				default: 'true',
				choices: [
					{ id: 'true', label: 'true' },
					{ id: 'false', label: 'false' },
				]
			},
			]
		},
		'mixer_setCueGain': {
			label: 'Mixer.SetCueGain',
			options: [{
				type: 'textinput',
				id: 'name',
				label: 'Name',
				default: '',
			},
			{
				type: 'textinput',
				id: 'cues',
				label: 'Cues',
				default: '1',
			},
			{
				type: 'number',
				id: 'value',
				label: 'Value',
				default: 0,
				regex: self.REGEX_NUMBER
			},
			{
				type: 'number',
				id: 'ramp',
				label: 'ramp',
				default: 0,
				regex: self.REGEX_NUMBER
			},
			]
		},
		'mixer_setInputCueEnable': {
			label: 'Mixer.SetInputCueEnable',
			options: [{
				type: 'textinput',
				id: 'name',
				label: 'Name',
				default: '',
			},
			{
				type: 'textinput',
				id: 'cues',
				label: 'Cues',
				default: '1',
			},
			{
				type: 'textinput',
				id: 'input',
				label: 'Input',
				default: '1',
			},
			{
				type: 'dropdown',
				id: 'value',
				label: 'Value',
				default: 'true',
				choices: [
					{ id: 'true', label: 'true' },
					{ id: 'false', label: 'false' },
				]
			},
			{
				type: 'number',
				id: 'ramp',
				label: 'ramp',
				default: 0,
				regex: self.REGEX_NUMBER
			},
			]
		},
		'mixer_setInputCueAfl': {
			label: 'Mixer.SetInputCueAfl',
			options: [{
				type: 'textinput',
				id: 'name',
				label: 'Name',
				default: '',
			},
			{
				type: 'textinput',
				id: 'cues',
				label: 'Cues',
				default: '1',
			},
			{
				type: 'textinput',
				id: 'input',
				label: 'Input',
				default: '1',
			},
			{
				type: 'dropdown',
				id: 'value',
				label: 'Value',
				default: 'true',
				choices: [
					{ id: 'true', label: 'true' },
					{ id: 'false', label: 'false' },
				]
			},
			]
		},



		'loopPlayer_start': {
			label: 'LoopPlayer.Start',
			options: [{
				type: 'textinput',
				id: 'file_name',
				label: 'File Name:',
				default: '',
			},
			{
				type: 'dropdown',
				id: 'channel',
				label: 'Channel',
				default: 'stereo',
				choices: [
					{ id: 'mono', label: 'Mono' },
					{ id: 'stereo', label: 'Stereo' },
				]
			},
			{
				type: 'textinput',
				id: 'output',
				label: 'Output',
				default: '1',
			},
			{
				type: 'number',
				id: 'startTime',
				label: 'Start Time',
				default: 0,
				regex: self.REGEX_NUMBER
			},
			{
				type: 'dropdown',
				id: 'loop',
				label: 'Loop',
				default: 'true',
				choices: [
					{ id: 'true', label: 'true' },
					{ id: 'false', label: 'false' },
				]
			}]
		},
		'loopPlayer_stop': {
			label: 'LoopPlayer.Stop',
			options: [{
				type: 'textinput',
				id: 'name',
				label: 'Name:',
				default: '',
			},
			{
				type: 'textinput',
				id: 'output',
				label: 'Output',
				default: '1',
			}]
		},
		'loopPlayer_cancel': {
			label: 'LoopPlayer.Cancel',
			options: [{
				type: 'textinput',
				id: 'name',
				label: 'Name:',
				default: '',
			},
			{
				type: 'textinput',
				id: 'output',
				label: 'Output',
				default: '1',
			}]
		},

	});
}

instance.prototype.action = function(action) {
	var self = this;
	var cmd;

	switch(action.action) {

		case 'control_set':											cmd = '"Control.Set", "params": { "Name": "' + action.options.name + '", "Value": "' + action.options.value + '" } }';	break;
		case 'component_set':										cmd = '"Component.Set", "params": { "Name": "' + action.options.name + '", "Controls": [{ "Name": "' + action.options.control_name + '", "Value": ' + action.options.value + ', "Ramp": ' + action.options.ramp + ' }] } }';	break;

		case 'changeGroup_addControl':					cmd = '"ChangeGroup.AddControl", "params": { "Id": "' + action.options.id + '", "Controls": [ ' + action.options.controls + ' ] } }';	break;
		case 'changeGroup_addComponentControl':	cmd = '"ChangeGroup.AddComponentControl", "params": { "Id": "' + action.options.id + '", "Controls": [ ' + action.options.controls + ' ] } }';	break;
		case 'changeGroup_remove':							cmd = '"ChangeGroup.Remove", "params": { "Id": "' + action.options.id + '", "Controls": [ ' + action.options.controls + ' ] } }';	break;
		case 'changeGroup_destroy':							cmd = '"ChangeGroup.Destroy", "params": { "Id": "' + action.options.id + '" } }';	break;
		case 'changeGroup_invalidate':					cmd = '"ChangeGroup.Invalidate", "params": { "Id": "' + action.options.id + '" } }';	break;
		case 'changeGroup_clear':								cmd = '"ChangeGroup.Clear", "params": { "Id": "' + action.options.id + '" } }';	break;

		case 'mixer_setCrossPointGain':					cmd = '"Mixer.SetCrossPointGain", "params": { "Name": "' + action.options.name + '", "Inputs": "' + action.options.input + '", "Outputs": "' + action.options.output + '", "Value": ' + action.options.value + ', "Ramp": ' + action.options.ramp + ' } }';	break;
		case 'mixer_setCrossPointDelay':				cmd = '"Mixer.SetCrossPointDelay", "params": { "Name": "' + action.options.name + '", "Inputs": "' + action.options.input + '", "Outputs": "' + action.options.output + '", "Value": ' + action.options.value + ', "Ramp": ' + action.options.ramp + ' } }';	break;
		case 'mixer_setCrossPointMute':					cmd = '"Mixer.SetCrossPointMute", "params": { "Name": "' + action.options.name + '", "Inputs": "' + action.options.input + '", "Outputs": "' + action.options.output + '", "Value": ' + action.options.value + ' } }';	break;
		case 'mixer_setCrossPointSolo':					cmd = '"Mixer.SetCrossPointSolo", "params": { "Name": "' + action.options.name + '", "Inputs": "' + action.options.input + '", "Outputs": "' + action.options.output + '", "Value": ' + action.options.value + ' } }';	break;
		case 'mixer_setInputGain':							cmd = '"Mixer.SetInputGain", "params": { "Name": "' + action.options.name + '", "Inputs": "' + action.options.input + '", "Value": ' + action.options.value + ', "Ramp": ' + action.options.ramp + ' } }';	break;
		case 'mixer_setInputMute':							cmd = '"Mixer.SetInputMute", "params": { "Name": "' + action.options.name + '", "Inputs": "' + action.options.input + '", "Value": ' + action.options.value + ', "Ramp": ' + action.options.ramp + ' } }';	break;
		case 'mixer_setInputSolo':							cmd = '"Mixer.SetInputSolo", "params": { "Name": "' + action.options.name + '", "Inputs": "' + action.options.input + '", "Value": ' + action.options.value + ' } }';	break;
		case 'mixer_setOutputGain':							cmd = '"Mixer.SetOutputGain", "params": { "Name": "' + action.options.name + '", "Outputs": "' + action.options.output + '", "Value": ' + action.options.value + ', "Ramp": ' + action.options.ramp + ' } }';	break;
		case 'mixer_setOutputMute':							cmd = '"Mixer.SetOutputMute", "params": { "Name": "' + action.options.name + '", "Outputs": "' + action.options.output + '", "Value": ' + action.options.value + ' } }';	break;
		case 'mixer_setCueMute':								cmd = '"Mixer.SetCueMute", "params": { "Name": "' + action.options.name + '", "Cues": "' + action.options.cues + '", "Value": ' + action.options.value + ' } }';	break;
		case 'mixer_setCueGain':								cmd = '"Mixer.SetCueGain", "params": { "Name": "' + action.options.name + '", "Cues": "' + action.options.cues + '", "Value": ' + action.options.value + ', "Ramp": ' + action.options.ramp + ' } }';	break;
		case 'mixer_setInputCueEnable':					cmd = '"Mixer.SetInputCueEnable", "params": { "Name": "' + action.options.name + '", "Cues": "' + action.options.cues + '", "Inputs": "' + action.options.input + '", "Value": ' + action.options.value + ' } }';	break;
		case 'mixer_setInputCueAfl':						cmd = '"Mixer.SetInputCueAfl", "params": { "Name": "' + action.options.name + '", "Cues": "' + action.options.cues + '", "Inputs": "' + action.options.input + '", "Value": ' + action.options.value + ' } }';	break;

		case 'loopPlayer_start':								cmd = '"LoopPlayer.Start", "params": { "Files": [ { "Name": "' + action.options.file_name + '", "Mode": "' + action.options.mode + '", "Output": ' + action.options.output + ' } ], "Name": "' + action.options.name + '", "StartTime": ' + action.options.startTime + ', "Loop": ' + action.options.loop + ', "Log": true }, }';	break;
		case 'loopPlayer_stop':									cmd = '"LoopPlayer.Stop", "params": { "Name": "' + action.options.name + '", "Outputs": ' + action.options.output + ', "Log": true } }';	break;
		case 'loopPlayer_cancel':								cmd = '"LoopPlayer.Cancel", "params": { "Name": "' + action.options.name + '", "Outputs": ' + action.options.output + ', "Log": true } }';	break;

	}




	if (cmd !== undefined) {

		debug('sending ','{ "jsonrpc": "2.0", "id": 1234, "method": ' + cmd,"to",self.config.host);

		if (self.socket !== undefined && self.socket.connected) {
			self.socket.send('{ "jsonrpc": "2.0", "id": 1234, "method": ' + cmd + '\r');
			if (cmd_debug == true) { console.log('Q-SYS Send: { "jsonrpc": "2.0", "id": 1234, "method": ' + cmd + '\r'); }

		}
		else {
			debug('Socket not connected :(');
		}
	}

}

instance_skel.extendedBy(instance);
exports = module.exports = instance;
