// Copyright 2015-2016, EMC, Inc.

'use strict';

var di = require('di');

module.exports = profileApiServiceFactory;
di.annotate(profileApiServiceFactory, new di.Provide('Http.Services.Api.Profiles'));
di.annotate(profileApiServiceFactory,
    new di.Inject(
        'Promise',
        'Http.Services.Api.Workflows',
        'Protocol.Task',
        'Protocol.Events',
        'Services.Waterline',
        'Services.Configuration',
        'Services.Lookup',
        'Logger',
        'Errors',
        '_'
    )
);
function profileApiServiceFactory(
    Promise,
    workflowApiService,
    taskProtocol,
    eventsProtocol,
    waterline,
    configuration,
    lookupService,
    Logger,
    Errors,
    _
) {

    var logger = Logger.initialize(profileApiServiceFactory);

    function ProfileApiService() {
    }

    // Helper to convert property kargs into an ipxe friendly string.
    ProfileApiService.prototype.convertProperties = function(properties) {
        properties = properties || {};

        if (properties.hasOwnProperty('kargs')) {
            // This a promotion of the kargs property
            // for DOS disks (or linux) for saving
            // the trouble of having to write a
            // bunch of code in the EJS template.
            properties.kargs = _.map(
                properties.kargs, function (value, key) {
                return key + '=' + value;
            }).join(' ');
        } else {
            // Ensure kargs is set for rendering.
            properties.kargs = null;
        }

        return properties;
    };

    ProfileApiService.prototype.getMacs = function(macs) {
        return _.flattenDeep([macs]);
    };

    ProfileApiService.prototype.setLookup = function(query) {
        if (query.mac && query.ip) {
            return waterline.nodes.findByIdentifier(this.getMacs(query.mac))
            .then(function (node) {
                if (_.isUndefined(node)) {
                    return lookupService.setIpAddress(
                        query.ip,
                        query.mac
                    );
                }
            });
        }
        return Promise.resolve();
    };

    ProfileApiService.prototype.getNode = function(macAddresses, type) {
        var self = this;
        return waterline.nodes.findByIdentifier(macAddresses)
        .then(function (node) {
            if (node) {
                return node.discovered()
                .then(function(discovered) {
                    if (!discovered) {
                        return taskProtocol.activeTaskExists(node.id)
                        .then(function() {
                            return node;
                        })
                        .catch(function() {
                            return self.runDiscovery(node, type);
                        });
                    } else {
                        // We only count a node as having been discovered if
                        // a node document exists AND it has any catalogs
                        // associated with it
                        return node;
                    }

                });
            } else {
                return self.createNodeAndRunDiscovery(macAddresses, type);
            }
        });
    };

    ProfileApiService.prototype.runDiscovery = function(node, type) {
        var self = this;

        if (type === 'switch') {
            logger.info("====== PAUL: Running switch discovery graph here ======");
            // TODO: Run ZTP graph and Graph.Switch.Discovery here!!!
            var configuration = {
                name: 'Graph.Switch.Discovery',
                options: {
                    defaults: {
                        graphOptions: {
                            target: node.id
                        },
                        nodeId: node.id
                    }
                }
            }
        } else {
            var configuration = {
                name: 'Graph.SKU.Discovery',
                options: {
                    defaults: {
                        graphOptions: {
                            target: node.id
                        },
                        nodeId: node.id
                    }
                }
            }
        };

        return workflowApiService.createAndRunGraph(configuration)
        .then(function() {
            return self.waitForDiscoveryStart(node.id);
        })
        .then(function() {
            return node;
        });
    };

    ProfileApiService.prototype.createNodeAndRunDiscovery = function(macAddresses, type) {
        var self = this;
        var node;
        return waterline.nodes.create({
            name: macAddresses.join(','),
            identifiers: macAddresses,
	    type: type
        })
        .then(function (_node) {
            node = _node;

            return Promise.resolve(macAddresses).each(function (macAddress) {
                return waterline.lookups.upsertNodeToMacAddress(node.id, macAddress);
            });
        })
        .then(function () {
            // Setting newRecord to true allows us to
            // render the redirect again to avoid refresh
            // of the node document and race conditions with
            // the state machine changing states.
            node.newRecord = true;

            return self.runDiscovery(node, type);
        });
    };

    // Quick and dirty extra two retries for the discovery graph, as the
    // runTaskGraph promise gets resolved before the tasks themselves are
    // necessarily started up and subscribed to bus events.
    ProfileApiService.prototype.waitForDiscoveryStart = function(nodeId) {
        var retryRequestProperties = function(error) {
            if (error instanceof Errors.RequestTimedOutError) {
                return taskProtocol.requestProperties(nodeId);
            } else {
                throw error;
            }
        };

        return taskProtocol.requestProperties(nodeId)
        .catch(retryRequestProperties)
        .catch(retryRequestProperties);
    };

    ProfileApiService.prototype.renderProfileFromTaskOrNode = function(node) {
        var self = this;
        return workflowApiService.findActiveGraphForTarget(node.id)
        .then(function (taskgraphInstance) {
            if (taskgraphInstance) {
                return taskProtocol.requestProfile(node.id)
                .then(function(profile) {
                    return [profile, taskProtocol.requestProperties(node.id)];
                })
                .spread(function (profile, properties) {
                    return {
                        profile: profile || 'redirect.ipxe',
                        options: self.convertProperties(properties)
                    };
                })
                .catch(function (e) {
                    logger.warning("Unable to retrieve workflow properties.", {
                        error: e,
                        id: node.id,
                        taskgraphInstance: taskgraphInstance
                    });
                    return {
                        profile: 'error.ipxe',
                        options: {
                            error: 'Unable to retrieve workflow properties.'
                        }
                    };
                });
            } else {
                if (_.has(node, 'bootSettings')) {
                    if (_.has(node.bootSettings, 'options') &&
                            _.has(node.bootSettings, 'profile')) {
                        return {
                            profile: node.bootSettings.profile,
                            options: node.bootSettings.options
                        };
                    } else {
                        return {
                            profile: 'error.ipxe',
                            options: {
                                error: 'Unable to retrieve node bootSettings.'
                            }
                        };
                    }
                }
                else {
                    return {
                        profile: 'error.ipxe',
                        options: {
                            error: 'Unable to locate active workflow or there is no bootSettings.'
                        }
                    };
                }
            }
        });
    };

    return new ProfileApiService();
}
