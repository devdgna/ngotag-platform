/* eslint-disable camelcase */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@credebl/prisma-service';
import { org_agents, org_agents_type, organisation, schema } from '@prisma/client';
import { ISchema, ISchemaSearchCriteria } from '../interfaces/schema-payload.interface';
import { ResponseMessages } from '@credebl/common/response-messages';

@Injectable()
export class SchemaRepository {
  private readonly logger = new Logger('SchemaRepository');

  constructor(
    private prisma: PrismaService
  ) { }
  async saveSchema(schemaResult: ISchema): Promise<schema> {
    try {
      if (schemaResult.schema.schemaName) {
        const schema = await this.schemaExists(
          schemaResult.schema.schemaName,
          schemaResult.schema.schemaVersion
        );

        const schemaLength = 0;
        if (schema.length !== schemaLength) {
          throw new BadRequestException(
            ResponseMessages.schema.error.exists
          );
        }
        const saveResult = await this.prisma.schema.create({
          data: {
            name: schemaResult.schema.schemaName,
            version: schemaResult.schema.schemaVersion,
            attributes: schemaResult.schema.attributes,
            schemaLedgerId: schemaResult.schema.id,
            issuerId: schemaResult.issuerId,
            createdBy: schemaResult.createdBy,
            lastChangedBy: schemaResult.changedBy,
            publisherDid: schemaResult.issuerId.split(':')[3],
            orgId: schemaResult.orgId,
            ledgerId: schemaResult.ledgerId
          }
        });
        return saveResult;
      }
    } catch (error) {
      this.logger.error(`Error in saving schema repository: ${error.message} `);
      throw error;
    }
  }

  async schemaExists(schemaName: string, schemaVersion: string): Promise<schema[]> {
    try {
      return this.prisma.schema.findMany({
        where: {
          name: {
            contains: schemaName,
            mode: 'insensitive'
          },
          version: {
            contains: schemaVersion,
            mode: 'insensitive'
          }
        }
      });
    } catch (error) {
      this.logger.error(`Error in schemaExists: ${error}`);
      throw error;
    }
  }

  async getSchemas(payload: ISchemaSearchCriteria, orgId: number): Promise<{
    createDateTime: Date;
    createdBy: number;
    name: string;
    version: string;
    attributes: string[];
    schemaLedgerId: string;
    publisherDid: string;
    orgId: number;
    issuerId: string;
  }[]> {
    try {
      const schemasResult = await this.prisma.schema.findMany({
        where: {
          orgId,
          OR: [
            { name: { contains: payload.searchByText, mode: 'insensitive' } },
            { version: { contains: payload.searchByText, mode: 'insensitive' } },
            { schemaLedgerId: { contains: payload.searchByText, mode: 'insensitive' } },
            { issuerId: { contains: payload.searchByText, mode: 'insensitive' } }
          ]
        },
        select: {
          createDateTime: true,
          name: true,
          version: true,
          attributes: true,
          schemaLedgerId: true,
          createdBy: true,
          publisherDid: true,
          orgId: true,
          issuerId: true
        },
        orderBy: {
          [payload.sorting]: 'DESC' === payload.sortByValue ? 'desc' : 'ASC' === payload.sortByValue ? 'asc' : 'desc'
        },
        take: payload.pageSize,
        skip: (payload.pageNumber - 1) * payload.pageSize
      });
      return schemasResult;
    } catch (error) {
      this.logger.error(`Error in getting schemas: ${error}`);
      throw error;
    }
  }

  async getAgentDetailsByOrgId(orgId: number): Promise<{
    orgDid: string;
    agentEndPoint: string;
    tenantId: string
  }> {
    try {
      const schemasResult = await this.prisma.org_agents.findFirst({
        where: {
          orgId
        },
        select: {
          orgDid: true,
          agentEndPoint: true,
          tenantId: true
        }
      });
      return schemasResult;
    } catch (error) {
      this.logger.error(`Error in getting agent DID: ${error}`);
      throw error;
    }
  }

  async getAgentType(orgId: number): Promise<organisation & {
    org_agents: (org_agents & {
      org_agent_type: org_agents_type;
    })[];
  }> {
    try {
      const agentDetails = await this.prisma.organisation.findUnique({
        where: {
          id: orgId
        },
        include: {
          org_agents: {
            include: {
              org_agent_type: true
            }
          }
        }
      });
      return agentDetails;
    } catch (error) {
      this.logger.error(`Error in getting agent type: ${error}`);
      throw error;
    }
  }

  async getSchemasCredDeffList(payload: ISchemaSearchCriteria, orgId: number, schemaId:string): Promise<{
    tag: string;
    credentialDefinitionId: string;
    schemaLedgerId: string;
    revocable: boolean;
}[]> {
    try {
        const schemasResult = await this.prisma.credential_definition.findMany({
            where: {
                AND:[
                    {orgId},
                    {schemaLedgerId:schemaId}
                ]
            },
            select: {
                tag: true,
                credentialDefinitionId: true,
                schemaLedgerId: true,
                revocable: true,
                createDateTime: true
            },
            orderBy: {
                [payload.sorting]: 'DESC' === payload.sortByValue ? 'desc' : 'ASC' === payload.sortByValue ? 'asc' : 'desc'
            }
        });
        return schemasResult;
    } catch (error) {
        this.logger.error(`Error in getting agent DID: ${error}`);
        throw error;
    }
}
}