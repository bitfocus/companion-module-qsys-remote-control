var tcp           = require('../../tcp');
var instance_skel = require('../../instance_skel');
var debug;
var log;
var cmd_debug = false;
var controls;

function instance(system, id, config) {
	var self = this;

	self.defineConst('QRC_GET', 1);
	self.defineConst('QRC_SET', 2);

	// super-constructor
	instance_skel.apply(this, arguments);

	self.actions(); // export actions
	//self.init_presets();

	if (self.config.feedback_enabled) {
		self.initControls();
		self.initFeedbacks();
		self.initPolling();
	}

	return self;
}

instance.prototype.pollQRCTimer = undefined;

instance.prototype.updateConfig = function(config) {
	var self = this;
	//self.init_presets();

	if (self.socket !== undefined) {
		self.socket.destroy();
		delete self.socket;
	}

	if (self.pollQRCTimer !== undefined) {
		clearInterval(self.pollQRCTimer);
		delete self.pollQRCTimer;
	}

	self.config = config;
	self.init_tcp();

	if (self.config.feedback_enabled) {
		self.initControls();
		self.initFeedbacks();
		self.initPolling();
	}
};

instance.prototype.init = function() {
	var self = this;

	debug = self.debug;
	log = self.log;
	//self.init_presets();
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

			let login = '{ "jsonrpc":"2.0", "method":"Logon", "params": { "User":"' + self.config.user + '", "Password":"' + self.config.pass + '" } }' + '\x00';

			if (cmd_debug == true) { console.log('Q-SYS Connected'); }
			if (cmd_debug == true) { console.log('Q-SYS Send: ' + login); }

			self.socket.write(login);

			socket.once('close', function() {
				if (cmd_debug == true) { console.log('Q-SYS Disconnect'); }
			})
		});

		self.socket.on('data', function (d) {
			response = d.toString();
			if (cmd_debug == true) { console.log(response);}

			if (self.config.feedback_enabled) {
				self.processResponse(response);
			}
		});

	}
};

instance.prototype.processResponse = function(response) {
	var messages = this.getMessages(response);
	var refresh = false;

	for (message of messages) {
		obj = JSON.parse(message.slice(0, -1)); // trim trailing null

		if ((obj.id !== undefined) && (obj.id == this.QRC_GET)) {
			if (obj.result !== undefined) {
				this.updateControl(obj);
				refresh = true;
			} else if (obj.error !== undefined) {
				console.log('Q-Sys error', obj.error);
			}
		}
	}
	if (refresh) { this.checkFeedbacks(); }
};

instance.prototype.getMessages = function(input) {
	messageStart = '{"jsonrpc"';
	remaining = input
	i = 1; //looking for the next message, not the first one
	messages = []

	while (i > 0) {
		i = remaining.indexOf(messageStart, 1);
		if (i > 0) {  // if there is another message, split off the first and repeat
			nextMessage = remaining.substring(0,i);
			remaining = remaining.substring(i);

			messages.push(nextMessage);
		} else {  // else add the last remaining message
			messages.push(remaining);
		}
	}
	return messages;
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
			type: 'checkbox',
			id: 'feedback_enabled',
			label: 'Feedback Enabled',
			default: false
		},
		{
			type: 'number',
			id: 'poll_interval',
			label: 'Polling Interval (ms)',
			min: 30,
			max: 60000,
			default: 100
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
		},
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

	if (self.pollQRCTimer !== undefined) {
		clearInterval(self.pollQRCTimer);
		delete self.pollQRCTimer;
	}

	if (self.controls !== undefined) {
		self.controls.destroy();
	}

	debug("destroy", self.id);
};

/*
instance.prototype.init_presets = function () {
	var self = this;
	var presets = [];
	var pstSize = '18';

	self.setPresetDefinitions(presets);
}
*/

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
		'control_toggle': {
			label: 'Control.toggle',
			options: [{
				type: 'textinput',
				id: 'name',
				label: 'Name:',
				default: '',
				tooltip: 'Only applies to controls with an on/off state.'
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
				id: 'inputs',
				label: 'Inputs',
				default: '1',
			},
			{
				type: 'textinput',
				id: 'outputs',
				label: 'Outputs',
				default: '1',
			},
			{
				type: 'number',
				id: 'value',
				label: 'Value',
				default: 0,
				min: -100,
				max: 20,
				regex: self.REGEX_NUMBER
			},
			{
				type: 'number',
				id: 'ramp',
				label: 'Ramp',
				default: 0,
				min: 0,
				max: 100,
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
				id: 'inputs',
				label: 'Inputs',
				default: '1',
			},
			{
				type: 'textinput',
				id: 'outputs',
				label: 'Outputs',
				default: '1',
			},
			{
				type: 'number',
				id: 'value',
				label: 'Value',
				default: 0,
				min: 0,
				max: 60,
				regex: self.REGEX_NUMBER
			},
			{
				type: 'number',
				id: 'ramp',
				label: 'Ramp',
				default: 0,
				min: 0,
				max: 100,
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
				id: 'inputs',
				label: 'Inputs',
				default: '1',
			},
			{
				type: 'textinput',
				id: 'outputs',
				label: 'Outputs',
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
				id: 'inputs',
				label: 'Inputs',
				default: '1',
			},
			{
				type: 'textinput',
				id: 'outputs',
				label: 'Outputs',
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
				id: 'inputs',
				label: 'Inputs',
				default: '1',
			},
			{
				type: 'number',
				id: 'value',
				label: 'Value',
				default: 0,
				min: -100,
				max: 20,
				regex: self.REGEX_NUMBER
			},
			{
				type: 'number',
				id: 'ramp',
				label: 'Ramp',
				default: 0,
				min: 0,
				max: 100,
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
				id: 'inputs',
				label: 'Inputs',
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
				id: 'inputs',
				label: 'Inputs',
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
				id: 'outputs',
				label: 'Outputs',
				default: '1',
			},
			{
				type: 'number',
				id: 'value',
				label: 'Value',
				default: 0,
				min: -100,
				max: 20,
				regex: self.REGEX_NUMBER
			},
			{
				type: 'number',
				id: 'ramp',
				label: 'Ramp',
				default: 0,
				min: 0,
				max: 100,
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
				id: 'outputs',
				label: 'Outputs',
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
				min: -100,
				max: 20,
				regex: self.REGEX_NUMBER
			},
			{
				type: 'number',
				id: 'ramp',
				label: 'Ramp',
				default: 0,
				min: 0,
				max: 100,
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
				id: 'inputs',
				label: 'Inputs',
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
				id: 'inputs',
				label: 'Inputs',
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
		case 'control_toggle':									{
			control = controls.get(action.options.name);
			// set our internal state in anticipation of success, allowing two presses
			// of the button faster than the polling interval to correctly toggle the state
			control.value = !control.value;
			cmd = '"Control.Set", "params": { "Name": "' + action.options.name + '", "Value": "' + control.value + '" } }';
			break;
		}
		case 'component_set':										cmd = '"Component.Set", "params": { "Name": "' + action.options.name + '", "Controls": [{ "Name": "' + action.options.control_name + '", "Value": ' + action.options.value + ', "Ramp": ' + action.options.ramp + ' }] } }';	break;

		case 'changeGroup_addControl':					cmd = '"ChangeGroup.AddControl", "params": { "Id": "' + action.options.id + '", "Controls": [ ' + action.options.controls + ' ] } }';	break;
		case 'changeGroup_addComponentControl':	cmd = '"ChangeGroup.AddComponentControl", "params": { "Id": "' + action.options.id + '", "Controls": [ ' + action.options.controls + ' ] } }';	break;
		case 'changeGroup_remove':							cmd = '"ChangeGroup.Remove", "params": { "Id": "' + action.options.id + '", "Controls": [ ' + action.options.controls + ' ] } }';	break;
		case 'changeGroup_destroy':							cmd = '"ChangeGroup.Destroy", "params": { "Id": "' + action.options.id + '" } }';	break;
		case 'changeGroup_invalidate':					cmd = '"ChangeGroup.Invalidate", "params": { "Id": "' + action.options.id + '" } }';	break;
		case 'changeGroup_clear':								cmd = '"ChangeGroup.Clear", "params": { "Id": "' + action.options.id + '" } }';	break;

		case 'mixer_setCrossPointGain':					cmd = '"Mixer.SetCrossPointGain", "params": { "Name": "' + action.options.name + '", "Inputs": "' + action.options.inputs + '", "Outputs": "' + action.options.outputs + '", "Value": ' + action.options.value + ', "Ramp": ' + action.options.ramp + ' } }';	break;
		case 'mixer_setCrossPointDelay':				cmd = '"Mixer.SetCrossPointDelay", "params": { "Name": "' + action.options.name + '", "Inputs": "' + action.options.inputs + '", "Outputs": "' + action.options.outputs + '", "Value": ' + action.options.value + ', "Ramp": ' + action.options.ramp + ' } }';	break;
		case 'mixer_setCrossPointMute':					cmd = '"Mixer.SetCrossPointMute", "params": { "Name": "' + action.options.name + '", "Inputs": "' + action.options.inputs + '", "Outputs": "' + action.options.outputs + '", "Value": ' + action.options.value + ' } }';	break;
		case 'mixer_setCrossPointSolo':					cmd = '"Mixer.SetCrossPointSolo", "params": { "Name": "' + action.options.name + '", "Inputs": "' + action.options.inputs + '", "Outputs": "' + action.options.outputs + '", "Value": ' + action.options.value + ' } }';	break;
		case 'mixer_setInputGain':							cmd = '"Mixer.SetInputGain", "params": { "Name": "' + action.options.name + '", "Inputs": "' + action.options.inputs + '", "Value": ' + action.options.value + ', "Ramp": ' + action.options.ramp + ' } }';	break;
		case 'mixer_setInputMute':							cmd = '"Mixer.SetInputMute", "params": { "Name": "' + action.options.name + '", "Inputs": "' + action.options.inputs + '", "Value": ' + action.options.value + ' } }';	break;
		case 'mixer_setInputSolo':							cmd = '"Mixer.SetInputSolo", "params": { "Name": "' + action.options.name + '", "Inputs": "' + action.options.inputs + '", "Value": ' + action.options.value + ' } }';	break;
		case 'mixer_setOutputGain':							cmd = '"Mixer.SetOutputGain", "params": { "Name": "' + action.options.name + '", "Outputs": "' + action.options.outputs + '", "Value": ' + action.options.value + ', "Ramp": ' + action.options.ramp + ' } }';	break;
		case 'mixer_setOutputMute':							cmd = '"Mixer.SetOutputMute", "params": { "Name": "' + action.options.name + '", "Outputs": "' + action.options.outputs + '", "Value": ' + action.options.value + ' } }';	break;
		case 'mixer_setCueMute':								cmd = '"Mixer.SetCueMute", "params": { "Name": "' + action.options.name + '", "Cues": "' + action.options.cues + '", "Value": ' + action.options.value + ' } }';	break;
		case 'mixer_setCueGain':								cmd = '"Mixer.SetCueGain", "params": { "Name": "' + action.options.name + '", "Cues": "' + action.options.cues + '", "Value": ' + action.options.value + ', "Ramp": ' + action.options.ramp + ' } }';	break;
		case 'mixer_setInputCueEnable':					cmd = '"Mixer.SetInputCueEnable", "params": { "Name": "' + action.options.name + '", "Cues": "' + action.options.cues + '", "Inputs": "' + action.options.inputs + '", "Value": ' + action.options.value + ' } }';	break;
		case 'mixer_setInputCueAfl':						cmd = '"Mixer.SetInputCueAfl", "params": { "Name": "' + action.options.name + '", "Cues": "' + action.options.cues + '", "Inputs": "' + action.options.inputs + '", "Value": ' + action.options.value + ' } }';	break;

		case 'loopPlayer_start':								cmd = '"LoopPlayer.Start", "params": { "Files": [ { "Name": "' + action.options.file_name + '", "Mode": "' + action.options.mode + '", "Output": ' + action.options.output + ' } ], "Name": "' + action.options.name + '", "StartTime": ' + action.options.startTime + ', "Loop": ' + action.options.loop + ', "Log": true }, }';	break;
		case 'loopPlayer_stop':									cmd = '"LoopPlayer.Stop", "params": { "Name": "' + action.options.name + '", "Outputs": ' + action.options.output + ', "Log": true } }';	break;
		case 'loopPlayer_cancel':								cmd = '"LoopPlayer.Cancel", "params": { "Name": "' + action.options.name + '", "Outputs": ' + action.options.output + ', "Log": true } }';	break;

	}

	if (cmd !== undefined) {
		full_cmd = '{ "jsonrpc": "2.0", "id": ' + self.QRC_SET + ', "method": ' + cmd;
		debug('sending ',full_cmd,"to",self.config.host);

		if (self.socket !== undefined && self.socket.connected) {
			self.socket.send(full_cmd + '\x00');
			if (cmd_debug == true) { console.log('Q-SYS Send: ' + full_cmd + '\r'); }

		}
		else {
			debug('Socket not connected :(');
		}
	}
}

instance.prototype.initControls = function() {
	controls = new Map();

	for (let bank in feedbacks) {
		for (let button in feedbacks[bank]) {
			feedback = feedbacks[bank][button];
			if (Object.keys(feedback).length > 0) {
				this.addControl(feedback[0]);
			}
		}
	}
}

instance.prototype.initFeedbacks = function () {
	var self = this;

	// feedbacks
	var feedbacks = {};

	feedbacks['control-string'] = {
		label: 'Change text to reflect control value',
		description: 'Will return current state of a control as a string',
		options: [{
				type: 'textinput',
				id: 'name',
				label: 'Name:',
				default: '',
			},
			{
				type: 'dropdown',
				id: 'type',
				label: 'Type',
				choices: [
					{ id: 'string',   label: 'String'},
					{ id: 'value',    label: 'Value'},
					{ id: 'position', label: 'Position'}
				],
				default: 'value'
			},
		],
		subscribe: (feedback) => { self.addControl(feedback); },
		unsubscribe: (feedback) => { self.removeControl(feedback); },
		callback: function(feedback, bank) {
			var opt = feedback.options;
			var control = controls.get(opt.name);
			switch (opt.type) {
				case 'string':   return { text: control.strval };
				case 'value':    return { text: control.value.toString() };
				case 'position': return { text: control.position.toString() };
				default: break;
			}

		}
	};

	feedbacks['control-boolean'] = {
		label: 'Toggle color on boolean control value',
		description: 'Toggle color on boolean control value',
		options: [{
				type: 'textinput',
				id: 'name',
				label: 'Name:',
				default: '',
			},
			{
				type: 'dropdown',
				id: 'value',
				label: 'Control value',
				choices: [
					{ id: 'true', label: 'True'},
					{ id: 'false', label: 'False'}
				],
				default: 'true'
			},
			{
				type: 'colorpicker',
				label: 'Foreground color',
				id: 'fg',
				default: self.rgb(255,255,255)
			},
			{
				type: 'colorpicker',
				label: 'Background color',
				id: 'bg',
				default: self.rgb(255,0,0)
			},
		],
		subscribe: (feedback) => { self.addControl(feedback); },
		unsubscribe: (feedback) => { self.removeControl(feedback); },
		callback: function(feedback, bank) {
			var opt = feedback.options;
			var control = controls.get(opt.name);

			switch (opt.value) {
				case 'true':  if (control.value)  { return { color: opt.fg, bgcolor: opt.bg }; } break;
				case 'false': if (!control.value) { return { color: opt.fg, bgcolor: opt.bg }; } break;
				default: break;
			}
		}
	};

	feedbacks['control-threshold'] = {
		label: 'Toggle color on control value at or exceeding threshold',
		description: 'Toggle color on control value at or exceeding threshold',
		options: [{
				type: 'textinput',
				id: 'name',
				label: 'Name:',
				default: '',
			},
			{
				type: 'number',
				id: 'threshold',
				label: 'Threshold value',
				default: '',
				min: -10000,
				max: 10000,
				range: false,
			},
			{
				type: 'colorpicker',
				label: 'Foreground color',
				id: 'fg',
				default: self.rgb(255,255,255)
			},
			{
				type: 'colorpicker',
				label: 'Background color',
				id: 'bg',
				default: self.rgb(255,0,0)
			},
		],
		subscribe: (feedback) => { self.addControl(feedback); },
		unsubscribe: (feedback) => { self.removeControl(feedback); },
		callback: function(feedback, bank) {
			var opt = feedback.options;
			var control = controls.get(opt.name);

			if (control.value >= opt.threshold) {
				return { color: opt.fg, bgcolor: opt.bg };
			}
		}
	};

	feedbacks['control-fade'] = {
		label: 'Fade color over control value range',
		description: 'Fade color over control value range',
		options: [{
				type: 'textinput',
				id: 'name',
				label: 'Name:',
				default: '',
			},
			{
				type: 'number',
				id: 'low_threshold',
				label: 'Low threshold value',
				default: '',
				min: -10000,
				max: 10000,
				range: false,
			},
			{
				type: 'number',
				id: 'high_threshold',
				label: 'High threshold value',
				default: '',
				min: -10000,
				max: 10000,
				range: false,
			},
			{
				type: 'colorpicker',
				label: 'Low threshold color',
				id: 'low_bg',
				default: self.rgb(0,0,0)
			},
			{
				type: 'colorpicker',
				label: 'High threshold color',
				id: 'high_bg',
				default: self.rgb(255,0,0)
			},
		],
		subscribe: (feedback) => { self.addControl(feedback); },
		unsubscribe: (feedback) => { self.removeControl(feedback); },
		callback: function(feedback, bank) {
			var opt = feedback.options;
			var control = controls.get(opt.name);
			var numToRGB = function(num) {
				var x = new Object();
				x.r = (num & 0xff0000) >> 16;
				x.g = (num & 0x00ff00) >> 8;
				x.b = (num & 0x0000ff);
				return x;
			}

			if ((control.value > opt.high_threshold) ||
				  (control.value < opt.low_threshold)) {
						return;
			}

			var range = opt.high_threshold - opt.low_threshold;
			var ratio = (control.value - opt.low_threshold) / range;

			hi_rgb = numToRGB(opt.high_bg);
			lo_rgb = numToRGB(opt.low_bg);

			var r = Math.round((hi_rgb.r - lo_rgb.r) * ratio) + lo_rgb.r;
			var g = Math.round((hi_rgb.g - lo_rgb.g) * ratio) + lo_rgb.g;
			var b = Math.round((hi_rgb.b - lo_rgb.b) * ratio) + lo_rgb.b;

			return { bgcolor: self.rgb(r, g, b) };
		}
	};

	self.setFeedbackDefinitions(feedbacks);
}

instance.prototype.getControlStatus = function(self, control) {
	cmd = '"Control.Get", "params": ["' + control + '"] }';

	if (cmd !== undefined) {

		full_cmd = '{ "jsonrpc": "2.0", "id": ' + self.QRC_GET + ', "method": ' + cmd
		debug('sending ',full_cmd,"to",self.config.host);

		if (self.socket !== undefined && self.socket.connected) {
			self.socket.send(full_cmd + '\x00');
			if (cmd_debug == true) { console.log('Q-SYS Send: ' + full_cmd + '\r'); }

		}
		else {
			debug('Socket not connected :(');
		}
	}
}

instance.prototype.getControlStatuses = function(self) {
	for (control of controls.keys()) {
		self.getControlStatus(self, control);
	}
}

instance.prototype.initPolling = function () {
	var self = this;
	if (self.config.feedback_enabled) {
		if (self.pollQRCTimer === undefined) {
			self.pollQRCTimer = setInterval(function () {self.getControlStatuses(self)}, self.config.poll_interval);
		}
	}
}

instance.prototype.addControl = function(feedback) {
	name = feedback['options']['name'];
	if (controls.has(name)) {
		control = controls.get(name);
		if (control.ids === undefined) {
			control.ids = new Set();
		}
		control.ids.add(feedback.id)
	} else {
		controls.set(name, {
			ids: new Set([feedback.id]),
			value: null,
			position: null,
			strval: ''});
	}
}

instance.prototype.removeControl = function(feedback) {
	name = feedback['options']['name'];

	if (controls.has(name)) {
		control = controls.get(name);
		if (control.ids !== undefined) {
			control.ids.delete(feedback.id);
		}
		if (control.ids.size == 0) {
			controls.delete(name);
		}
	}
}

instance.prototype.updateControl = function(update) {
	name = update.result[0].Name;
	control = controls.get(name);
	control.value    = update.result[0].Value;
	control.strval   = update.result[0].String;
	control.position = update.result[0].Position;
}

instance_skel.extendedBy(instance);
exports = module.exports = instance;
