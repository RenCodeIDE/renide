/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MerkleTreeService as NodeMerkleTreeService } from '../../../../platform/merkleTree/node/merkleTreeService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IMerkleTreeService } from '../../../../platform/merkleTree/common/merkleTreeService.js';

export class MerkleTreeService extends NodeMerkleTreeService {
	// Browser implementation can override Node implementation if needed
}

registerSingleton(IMerkleTreeService, MerkleTreeService, InstantiationType.Delayed);

