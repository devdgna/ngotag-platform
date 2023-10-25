/* eslint-disable camelcase */
import { CommonService } from '@credebl/common';
import { HttpException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { IssuanceRepository } from './issuance.repository';
import { IUserRequest } from '@credebl/user-request/user-request.interface';
import { CommonConstants } from '@credebl/common/common.constant';
import { ResponseMessages } from '@credebl/common/response-messages';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { map } from 'rxjs';
import { ICredentialAttributesInterface, OutOfBandCredentialOfferPayload } from '../interfaces/issuance.interfaces';
import { OrgAgentType } from '@credebl/enum/enum';
import { platform_config } from '@prisma/client';
import * as QRCode from 'qrcode';
import { OutOfBandIssuance } from '../templates/out-of-band-issuance.template';
import { EmailDto } from '@credebl/common/dtos/email.dto';
import { sendEmail } from '@credebl/common/send-grid-helper-file';


@Injectable()
export class IssuanceService {
  private readonly logger = new Logger('IssueCredentialService');
  constructor(
    @Inject('NATS_CLIENT') private readonly issuanceServiceProxy: ClientProxy,
    private readonly commonService: CommonService,
    private readonly issuanceRepository: IssuanceRepository,
    private readonly outOfBandIssuance: OutOfBandIssuance,
    private readonly emailData: EmailDto
  ) { }


  async sendCredentialCreateOffer(orgId: number, user: IUserRequest, credentialDefinitionId: string, comment: string, connectionId: string, attributes: object[]): Promise<string> {
    try {
      const agentDetails = await this.issuanceRepository.getAgentEndPoint(orgId);
      const platformConfig: platform_config = await this.issuanceRepository.getPlatformConfigDetails();

      const { agentEndPoint } = agentDetails;
      if (!agentDetails) {
        throw new NotFoundException(ResponseMessages.issuance.error.agentEndPointNotFound);
      }

      const issuanceMethodLabel = 'create-offer';
      const url = await this.getAgentUrl(issuanceMethodLabel, agentDetails?.orgAgentTypeId, agentEndPoint, agentDetails?.tenantId);

      const apiKey = platformConfig?.sgApiKey;
      const issueData = {
        protocolVersion: 'v1',
        connectionId,
        credentialFormats: {
          indy: {
            attributes,
            credentialDefinitionId
          }
        },
        autoAcceptCredential: 'always',
        comment
      };

      const credentialCreateOfferDetails = await this._sendCredentialCreateOffer(issueData, url, apiKey);

      return credentialCreateOfferDetails?.response;
    } catch (error) {
      this.logger.error(`[sendCredentialCreateOffer] - error in create credentials : ${JSON.stringify(error)}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }


  async sendCredentialOutOfBand(orgId: number, user: IUserRequest, credentialDefinitionId: string, comment: string, connectionId: string, attributes: object[]): Promise<string> {
    try {
      const agentDetails = await this.issuanceRepository.getAgentEndPoint(orgId);
      // eslint-disable-next-line camelcase
      const platformConfig: platform_config = await this.issuanceRepository.getPlatformConfigDetails();

      const { agentEndPoint } = agentDetails;
      if (!agentDetails) {
        throw new NotFoundException(ResponseMessages.issuance.error.agentEndPointNotFound);
      }

      const issuanceMethodLabel = 'create-offer-oob';
      const url = await this.getAgentUrl(issuanceMethodLabel, agentDetails?.orgAgentTypeId, agentEndPoint, agentDetails?.tenantId);

      const apiKey = platformConfig?.sgApiKey;
      const issueData = {
        connectionId,
        credentialFormats: {
          indy: {
            attributes,
            credentialDefinitionId
          }
        },
        autoAcceptCredential: 'always',
        comment
      };
      const credentialCreateOfferDetails = await this._sendCredentialCreateOffer(issueData, url, apiKey);
      return credentialCreateOfferDetails?.response;
    } catch (error) {
      this.logger.error(`[sendCredentialCreateOffer] - error in create credentials : ${JSON.stringify(error)}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }

  async natsCall(pattern: object, payload: object): Promise<{
    response: string;
  }> {
    try {
      return this.issuanceServiceProxy
        .send<string>(pattern, payload)
        .pipe(
          map((response) => (
            {
              response
            }))
        ).toPromise()
        .catch(error => {
          this.logger.error(`catch: ${JSON.stringify(error)}`);
          throw new HttpException(
            {
              status: error.statusCode,
              error: error.message
            }, error.error);
        });
    } catch (error) {
      this.logger.error(`[natsCall] - error in nats call : ${JSON.stringify(error)}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }

  async _sendCredentialCreateOffer(issueData: object, url: string, apiKey: string): Promise<{
    response: string;
  }> {
    try {
      const pattern = { cmd: 'agent-send-credential-create-offer' };
      const payload = { issueData, url, apiKey };
      return await this.natsCall(pattern, payload);
    } catch (error) {
      this.logger.error(`[_sendCredentialCreateOffer] [NATS call]- error in create credentials : ${JSON.stringify(error)}`);
      throw error;
    }
  }

  async getIssueCredentials(user: IUserRequest, threadId: string, connectionId: string, state: string, orgId: number): Promise<string> {
    try {
      const agentDetails = await this.issuanceRepository.getAgentEndPoint(orgId);
      const platformConfig: platform_config = await this.issuanceRepository.getPlatformConfigDetails();

      const { agentEndPoint } = agentDetails;
      if (!agentDetails) {
        throw new NotFoundException(ResponseMessages.issuance.error.agentEndPointNotFound);
      }
      const params = {
        threadId,
        connectionId,
        state
      };

      const issuanceMethodLabel = 'get-issue-credentials';
      let url = await this.getAgentUrl(issuanceMethodLabel, agentDetails?.orgAgentTypeId, agentEndPoint, agentDetails?.tenantId);

      Object.keys(params).forEach((element: string) => {
        const appendParams: string = url.includes('?') ? '&' : '?';

        if (params[element] !== undefined) {
          url = `${url + appendParams + element}=${params[element]}`;
        }
      });
      const apiKey = platformConfig?.sgApiKey;
      const issueCredentialsDetails = await this._getIssueCredentials(url, apiKey);
      return issueCredentialsDetails?.response;
    } catch (error) {
      this.logger.error(`[sendCredentialCreateOffer] - error in create credentials : ${JSON.stringify(error)}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }

  async _getIssueCredentials(url: string, apiKey: string): Promise<{
    response: string;
  }> {
    try {
      const pattern = { cmd: 'agent-get-all-issued-credentials' };
      const payload = { url, apiKey };
      return await this.natsCall(pattern, payload);
    } catch (error) {
      this.logger.error(`[_getIssueCredentials] [NATS call]- error in fetch credentials : ${JSON.stringify(error)}`);
      throw error;
    }
  }

  async getIssueCredentialsbyCredentialRecordId(user: IUserRequest, credentialRecordId: string, orgId: number): Promise<string> {
    try {

      const agentDetails = await this.issuanceRepository.getAgentEndPoint(orgId);
      const platformConfig: platform_config = await this.issuanceRepository.getPlatformConfigDetails();

      const { agentEndPoint } = agentDetails;
      if (!agentDetails) {
        throw new NotFoundException(ResponseMessages.issuance.error.agentEndPointNotFound);
      }

      const issuanceMethodLabel = 'get-issue-credential-by-credential-id';
      const url = await this.getAgentUrl(issuanceMethodLabel, agentDetails?.orgAgentTypeId, agentEndPoint, agentDetails?.tenantId, credentialRecordId);

      const apiKey = platformConfig?.sgApiKey;
      const createConnectionInvitation = await this._getIssueCredentialsbyCredentialRecordId(url, apiKey);
      return createConnectionInvitation?.response;
    } catch (error) {
      this.logger.error(`[getIssueCredentialsbyCredentialRecordId] - error in get credentials : ${JSON.stringify(error)}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }

  async getIssueCredentialWebhook(createDateTime: string, connectionId: string, threadId: string, protocolVersion: string, credentialAttributes: ICredentialAttributesInterface[], orgId: number): Promise<object> {
    try {
      const agentDetails = await this.issuanceRepository.saveIssuedCredentialDetails(createDateTime, connectionId, threadId, protocolVersion, credentialAttributes, orgId);
      return agentDetails;
    } catch (error) {
      this.logger.error(`[getIssueCredentialsbyCredentialRecordId] - error in get credentials : ${JSON.stringify(error)}`);
      throw new RpcException(error.response ? error.response : error);
    }
  }

  async _getIssueCredentialsbyCredentialRecordId(url: string, apiKey: string): Promise<{
    response: string;
  }> {
    try {
      const pattern = { cmd: 'agent-get-issued-credentials-by-credentialDefinitionId' };
      const payload = { url, apiKey };
      return await this.natsCall(pattern, payload);

    } catch (error) {
      this.logger.error(`[_getIssueCredentialsbyCredentialRecordId] [NATS call]- error in fetch credentials : ${JSON.stringify(error)}`);
      throw error;
    }
  }


  async outOfBandCredentialOffer(user: IUserRequest, outOfBandCredential: OutOfBandCredentialOfferPayload): Promise<boolean> {
    try {
      const {
        credentialOffer,
        comment,
        credentialDefinitionId,
        orgId,
        protocolVersion,
        attributes,
        emailId
      } = outOfBandCredential;

      // Define a batch size
      const batchSize = 100; // Adjust this based on your needs

      const agentDetails = await this.issuanceRepository.getAgentEndPoint(orgId);
      if (!agentDetails) {
        throw new NotFoundException(ResponseMessages.issuance.error.agentEndPointNotFound);
      }

      const issuanceMethodLabel = 'create-offer-oob';
      const url = await this.getAgentUrl(issuanceMethodLabel, agentDetails.orgAgentTypeId, agentDetails.agentEndPoint, agentDetails.tenantId);
      const organizationDetails = await this.issuanceRepository.getOrganization(orgId);

      if (!organizationDetails) {
        throw new NotFoundException(ResponseMessages.issuance.error.organizationNotFound);
      }

      const { apiKey } = agentDetails;

      const errors = [];
      const emailPromises = [];

      const sendEmailForCredentialOffer = async (iterator, emailId): Promise<boolean> => {
        try {
          const outOfBandIssuancePayload = {
            protocolVersion: protocolVersion || 'v1',
            credentialFormats: {
              indy: {
                attributes: iterator.attributes || attributes,
                credentialDefinitionId
              }
            },
            autoAcceptCredential: 'always',
            comment
          };


          const credentialCreateOfferDetails = await this._outOfBandCredentialOffer(outOfBandIssuancePayload, url, apiKey);
          if (!credentialCreateOfferDetails) {
            errors.push(ResponseMessages.issuance.error.credentialOfferNotFound);
            return false;
          }

          const invitationId = credentialCreateOfferDetails.response.invitation['@id'];
          if (!invitationId) {
            errors.push(ResponseMessages.issuance.error.invitationNotFound);
            return false;
          }

          const agentEndPoint = agentDetails.tenantId
            ? `${agentDetails.agentEndPoint}/multi-tenancy/url/${agentDetails.tenantId}/${invitationId}`
            : `${agentDetails.agentEndPoint}/url/${invitationId}`;

          const qrCodeOptions = { type: 'image/png' };
          const outOfBandIssuanceQrCode = await QRCode.toDataURL(agentEndPoint, qrCodeOptions);
          const platformConfigData = await this.issuanceRepository.getPlatformConfigDetails();

          if (!platformConfigData) {
            errors.push(ResponseMessages.issuance.error.platformConfigNotFound);
            return false;
          }

          this.emailData.emailFrom = platformConfigData.emailFrom;
          this.emailData.emailTo = emailId;
          this.emailData.emailSubject = `${process.env.PLATFORM_NAME} Platform: Issuance of Your Credentials Required`;
          this.emailData.emailHtml = await this.outOfBandIssuance.outOfBandIssuance(emailId, organizationDetails.name, outOfBandIssuanceQrCode);
          this.emailData.emailAttachments = [
            {
              filename: 'qrcode.png',
              content: outOfBandIssuanceQrCode.split(';base64,')[1],
              contentType: 'image/png',
              disposition: 'attachment'
            }
          ];

          const isEmailSent = await sendEmail(this.emailData);
          if (!isEmailSent) {
            errors.push(ResponseMessages.issuance.error.emailSend);
            return false;
          }

          return isEmailSent;
        } catch (error) {
          errors.push(error.message);
          return false;
        }
      };

      if (credentialOffer) {
        for (let i = 0; i < credentialOffer.length; i += batchSize) {
          const batch = credentialOffer.slice(i, i + batchSize);

          // Process each batch in parallel
          const batchPromises = batch.map((iterator) => sendEmailForCredentialOffer(iterator, iterator.emailId));

          emailPromises.push(Promise.all(batchPromises));
        }
      } else {
        emailPromises.push(sendEmailForCredentialOffer({}, emailId));
      }

      const results = await Promise.all(emailPromises);

      // Flatten the results array
      const flattenedResults = [].concat(...results);

      // Check if all emails were successfully sent
      const allSuccessful = flattenedResults.every((result) => true === result);

      if (0 < errors.length) {
        this.logger.error(errors);
      }

      return allSuccessful;
    } catch (error) {
      this.logger.error(`[outOfBoundCredentialOffer] - error in create out-of-band credentials: ${JSON.stringify(error)}`);
      throw new RpcException(error);
    }
  }


  async _outOfBandCredentialOffer(outOfBandIssuancePayload: object, url: string, apiKey: string): Promise<{
    response;
  }> {
    try {
      const pattern = { cmd: 'agent-out-of-band-credential-offer' };
      const payload = { outOfBandIssuancePayload, url, apiKey };
      return await this.natsCall(pattern, payload);
    } catch (error) {
      this.logger.error(`[_outOfBandCredentialOffer] [NATS call]- error in out of band  : ${JSON.stringify(error)}`);
      throw error;
    }
  }

  /**
  * Description: Fetch agent url 
  * @param referenceId 
  * @returns agent URL
  */
  async getAgentUrl(
    issuanceMethodLabel: string,
    orgAgentTypeId: number,
    agentEndPoint: string,
    tenantId: string,
    credentialRecordId?: string
  ): Promise<string> {
    try {

      let url;
      switch (issuanceMethodLabel) {
        case 'create-offer': {
          url = orgAgentTypeId === OrgAgentType.DEDICATED
            ? `${agentEndPoint}${CommonConstants.URL_ISSUE_CREATE_CRED_OFFER_AFJ}`
            : orgAgentTypeId === OrgAgentType.SHARED
              ? `${agentEndPoint}${CommonConstants.URL_SHAGENT_CREATE_OFFER}`.replace('#', tenantId)
              : null;
          break;
        }

        case 'create-offer-oob': {
          url = orgAgentTypeId === OrgAgentType.DEDICATED
            ? `${agentEndPoint}${CommonConstants.URL_OUT_OF_BAND_CREDENTIAL_OFFER}`
            : orgAgentTypeId === OrgAgentType.SHARED
              ? `${agentEndPoint}${CommonConstants.URL_SHAGENT_CREATE_OFFER_OUT_OF_BAND}`.replace('#', tenantId)
              : null;
          break;
        }

        case 'get-issue-credentials': {
          url = orgAgentTypeId === OrgAgentType.DEDICATED
            ? `${agentEndPoint}${CommonConstants.URL_ISSUE_GET_CREDS_AFJ}`
            : orgAgentTypeId === OrgAgentType.SHARED
              ? `${agentEndPoint}${CommonConstants.URL_SHAGENT_GET_CREDENTIALS}`.replace('#', tenantId)
              : null;
          break;
        }

        case 'get-issue-credential-by-credential-id': {

          url = orgAgentTypeId === OrgAgentType.DEDICATED
            ? `${agentEndPoint}${CommonConstants.URL_ISSUE_GET_CREDS_AFJ_BY_CRED_REC_ID}/${credentialRecordId}`
            : orgAgentTypeId === OrgAgentType.SHARED
              ? `${agentEndPoint}${CommonConstants.URL_SHAGENT_GET_CREDENTIALS_BY_CREDENTIAL_ID}`.replace('#', credentialRecordId).replace('@', tenantId)
              : null;
          break;
        }

        default: {
          break;
        }
      }

      if (!url) {
        throw new NotFoundException(ResponseMessages.issuance.error.agentUrlNotFound);
      }

      return url;
    } catch (error) {
      this.logger.error(`Error in get agent url: ${JSON.stringify(error)}`);
      throw error;
    }
  }
}
